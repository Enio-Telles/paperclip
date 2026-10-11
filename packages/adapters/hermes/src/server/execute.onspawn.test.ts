/**
 * Regression test for onSpawn forwarding in the hermes-local adapter.
 *
 * Ensures ctx.onSpawn is forwarded to runChildProcess() so the orphan
 * reaper can track live child processes by PID, preventing false-positive
 * reaps on runs whose updatedAt becomes stale.
 *
 * @see https://github.com/paperclipai/paperclip/issues/8723
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the adapter-utils server-utils module that execute.ts imports from.
// We intercept runChildProcess so we can inspect its opts without spawning
// a real child process.
vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    ensureAbsoluteDirectory: vi.fn(async () => undefined),
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

// Mock fs and path resolution to avoid real file reads in execute()
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx(overrides: Record<string, unknown> = {}) {
  const onSpawn = vi.fn(async () => undefined);
  return {
    ctx: {
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "/usr/bin/hermes",
        timeoutSec: 60,
        graceSec: 5,
        ...overrides,
      },
      context: {
        issueId: "issue-1",
        wakeReason: "manual",
        paperclipWake: null,
      },
      onLog: vi.fn(async () => undefined),
      onMeta: vi.fn(async () => undefined),
      onSpawn,
    } satisfies Record<string, unknown>,
    onSpawn,
  };
}

describe("hermes-local adapter onSpawn forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards ctx.onSpawn to runChildProcess", async () => {
    const { ctx, onSpawn } = makeCtx();

    // execute() will call runChildProcess internally.
    // We expect it to propagate ctx.onSpawn.
    // Because we mocked runChildProcess, the actual child doesn't spawn,
    // but we can verify it was called with onSpawn.
    try {
      await execute(ctx as any);
    } catch {
      // execute may fail due to missing hermes binary / env — that's OK,
      // we only care that runChildProcess was called with onSpawn.
    }

    const mocked = vi.mocked(serverUtils.runChildProcess);
    expect(mocked.mock.calls.length).toBeGreaterThan(0);
    const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
    const opts = lastCall[3] as Record<string, unknown>;
    expect(opts.onSpawn).toBe(onSpawn);
  });

  it("keeps wake data in the prompt and drops configured JSON env copies", async () => {
    const { ctx } = makeCtx({ env: { PAPERCLIP_WAKE_PAYLOAD_JSON: "stale configured wake" } });
    const wake = { reason: "issue_assigned", issue: { id: "issue-1", description: "Current task brief" } };
    await execute({ ...ctx, context: { ...ctx.context, paperclipWake: wake } } as any);
    const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    expect(call[3].env).not.toHaveProperty("PAPERCLIP_WAKE_PAYLOAD_JSON");
    expect(call[2]).toContainEqual(expect.stringContaining("Current task brief"));
  });

  it("launches in the assigned task workspace when no cwd was configured", async () => {
    const { ctx } = makeCtx();
    await execute({ ...ctx, context: { ...ctx.context, paperclipWorkspace: { cwd: "/private/qa/agent-workspace", source: "task_session" } } } as any);
    expect(vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![3].cwd).toBe("/private/qa/agent-workspace");
  });

  it("preserves an explicitly configured cwd", async () => {
    const { ctx } = makeCtx({ cwd: "/private/qa/configured-workspace" });
    await execute({ ...ctx, context: { ...ctx.context, paperclipWorkspace: { cwd: "/private/qa/agent-workspace", source: "agent_home" } } } as any);
    expect(vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![3].cwd).toBe("/private/qa/configured-workspace");
  });

  it("passes only current project workspace metadata to runChildProcess", async () => {
    const { ctx } = makeCtx({
      env: {
        AGENT_HOME: "/old/agent",
        PAPERCLIP_WORKSPACE_CWD: "/old/project",
        PAPERCLIP_WORKSPACE_REPO_URL: "https://user:token@old.invalid/repo",
      },
    });
    await execute({
      ...ctx,
      context: {
        ...ctx.context,
        paperclipWorkspace: {
          source: "project_primary", cwd: "/new/project",
          repoUrl: "https://username:fakepass@github.com/acme/repo.git?auth=secret",
          branchName: "main",
        },
      },
    } as any);
    const last = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    const env = last[3].env as Record<string, string>;
    expect(last[3].cwd).toBe("/new/project");
    expect(env.PAPERCLIP_WORKSPACE_CWD).toBe("/new/project");
    expect(env.PAPERCLIP_WORKSPACE_REPO_URL).toBe("https://github.com/acme/repo.git");
    expect(env.AGENT_HOME).toBeUndefined();
    expect(env.PAPERCLIP_WORKSPACE_BRANCH).toBe("main");
    expect(JSON.stringify(env)).not.toContain("fakepass");
  });

  it("refuses to launch a project run when workspace directory validation fails", async () => {
    const { ctx } = makeCtx();
    vi.mocked(serverUtils.ensureAbsoluteDirectory).mockRejectedValueOnce(new Error("not a workspace directory"));
    await expect(execute({
      ...ctx, context: { ...ctx.context, paperclipWorkspace: { source: "project_primary", cwd: "/invalid/path" } },
    } as any)).rejects.toThrow("not a workspace directory");
    expect(vi.mocked(serverUtils.runChildProcess)).not.toHaveBeenCalled();
  });

  it("does not resume a Hermes session from a different project checkout", async () => {
    const { ctx } = makeCtx({ persistSession: true });
    await execute({
      ...ctx,
      runtime: { ...ctx.runtime, sessionParams: { sessionId: "previous-session", cwd: "/other/project" } },
      context: { ...ctx.context, paperclipWorkspace: { source: "task_session", cwd: "/current/project" } },
    } as any);
    const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    expect(call[2]).not.toContain("--resume");
    expect(call[3].cwd).toBe("/current/project");
  });

  it("resumes a Hermes session when its checkout is unchanged", async () => {
    const { ctx } = makeCtx({ persistSession: true });
    await execute({
      ...ctx,
      runtime: { ...ctx.runtime, sessionParams: { sessionId: "stable-session", cwd: "/current/project" } },
      context: { ...ctx.context, paperclipWorkspace: { source: "project_primary", cwd: "/current/project" } },
    } as any);
    const call = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)!;
    expect(call[2]).toContain("--resume");
    expect(call[2]).toContain("stable-session");
  });

  it("runChildProcess opts type includes onSpawn", () => {
    // Type-level assertion: if onSpawn were removed from the type,
    // this file would fail to compile. The runtime test above catches
    // the behavioral case; this documents the contract.
    const opts: Parameters<typeof serverUtils.runChildProcess>[3] = {
      cwd: "/tmp",
      env: {},
      timeoutSec: 60,
      graceSec: 5,
      onLog: async () => undefined,
      onSpawn: async () => undefined,
    };
    expect(opts.onSpawn).toBeDefined();
  });

  it("preserves a specific stderr diagnostic for a nonzero exit", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Error: provider unavailable\n",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBe("Error: provider unavailable");
  });

  it("reports the exit code when a nonzero exit has no diagnostic", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 130,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBe("Hermes exited with code 130");
  });

  it("leaves timeout diagnostics to the heartbeat timeout path", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not label signal cancellation as a silent nonzero exit", async () => {
    vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: null,
    });

    const { ctx } = makeCtx();
    const result = await execute(ctx as any);

    expect(result.errorMessage).toBeUndefined();
  });

  it("does not inherit PAPERCLIP_API_KEY without a harness token", async () => {
    const previousApiKey = process.env.PAPERCLIP_API_KEY;
    process.env.PAPERCLIP_API_KEY = "parent-process-key";

    try {
      const { ctx } = makeCtx();
      await execute(ctx as any);

      const mocked = vi.mocked(serverUtils.runChildProcess);
      const lastCall = mocked.mock.calls[mocked.mock.calls.length - 1];
      const opts = lastCall[3] as { env: Record<string, string> };
      expect(opts.env.PAPERCLIP_API_KEY).toBeUndefined();
    } finally {
      if (previousApiKey === undefined) delete process.env.PAPERCLIP_API_KEY;
      else process.env.PAPERCLIP_API_KEY = previousApiKey;
    }
  });
});
