import { expect, test } from "vitest";
import { resolveHermesCwd, buildHermesWorkspaceEnv, resolveHermesSessionId } from "./execute.js";

const context = (source: string, cwd: string) => ({ paperclipWorkspace: { source, cwd } });

test("project workspace must not silently fall back to agent cwd if invalid or unrecognized", () => {
  expect(() => resolveHermesCwd({ cwd: "/agent/static" }, context("project_primary", "../relative"))).toThrow();
  expect(() => resolveHermesCwd({ cwd: "/agent/static" }, context("project_primary", ""))).toThrow();
  expect(() => resolveHermesCwd({ cwd: "/agent/static" }, context("unknown", "/another/project"))).toThrow();
  expect(resolveHermesCwd({ cwd: "/agent/static" }, context("task_session", "/project/session"))).toBe("/project/session");
});

test("workspace env is authoritative despite a stale user-configured value", () => {
  const env = {
    PAPERCLIP_WORKSPACE_CWD: "/other/project",
    PAPERCLIP_WORKSPACE_BRANCH: "other",
    AGENT_HOME: "/other/home",
    PAPERCLIP_WORKSPACES_JSON: '[{"secret":"token"}]',
    HOME: "/user/home",
  };
  const result = buildHermesWorkspaceEnv(env, {
    paperclipWorkspace: {
      source: "project_primary", cwd: "/my/project", branchName: "feature",
      agentHome: "/my/home",
    },
  }, "/my/project");
  expect(result.PAPERCLIP_WORKSPACE_CWD).toBe("/my/project");
  expect(result.PAPERCLIP_WORKSPACE_BRANCH).toBe("feature");
  expect(result.AGENT_HOME).toBe("/my/home");
  expect(result.PAPERCLIP_WORKSPACES_JSON).toBeUndefined();
  expect(result.HOME).toBe("/user/home");
});

test("two successive runs cannot inherit prior workspace metadata", () => {
  const a = buildHermesWorkspaceEnv({ HOME: "/home/user", AGENT_HOME: "/stale" }, {
    paperclipWorkspace: { source: "task_session", cwd: "/project/a", agentHome: "/project/a/home" },
  }, "/project/a");
  const b = buildHermesWorkspaceEnv({ ...a, PAPERCLIP_WORKSPACE_CWD: "/project/a" }, {
    paperclipWorkspace: { source: "agent_home", cwd: "/project/b" },
  }, "/project/b");
  expect(b.PAPERCLIP_WORKSPACE_CWD).toBe("/project/b");
  expect(b.AGENT_HOME).toBeUndefined();
  expect(b.PAPERCLIP_WORKSPACE_BRANCH).toBeUndefined();
  expect(b.HOME).toBe("/home/user");
});

test("workspace hints contain only whitelisted fields, sanitized URLs and observable truncation", () => {
  const env = buildHermesWorkspaceEnv({}, {
    paperclipWorkspace: { source: "project_primary", cwd: "/anchor", repoUrl: "https://user:fake-token@github.com/acme/repo.git?token=leak" },
    paperclipWorkspaces: [
      { projectId: "p", workspaceId: "w", cwd: "/ref", repoUrl: "https://u:secret@host/repo", secret: "must-not-leak", repoRef: "main" },
      { projectId: "p2", cwd: "/another", secret: "nope" },
    ],
  }, "/anchor");
  const printed = JSON.stringify(env);
  expect(printed).not.toContain("fake-token");
  expect(printed).not.toContain("leak");
  expect(printed).not.toContain("must-not-leak");
  expect(printed).not.toContain("secret");
  expect(env.PAPERCLIP_WORKSPACE_REPO_URL).toBe("https://github.com/acme/repo.git");
  expect(JSON.parse(env.PAPERCLIP_WORKSPACES_JSON || "[]")).toHaveLength(2);
  const large = Array.from({ length: 250 }, (_, i) => ({ projectId: "p" + i, cwd: "/src/" + "a".repeat(150), secret: "hidden" }));
  const capped = buildHermesWorkspaceEnv({}, {
    paperclipWorkspace: { source: "project_primary", cwd: "/anchor" }, paperclipWorkspaces: large,
  }, "/anchor");
  expect(Buffer.byteLength(capped.PAPERCLIP_WORKSPACES_JSON || "", "utf8")).toBeLessThanOrEqual(16000);
  expect(capped.PAPERCLIP_WORKSPACES_TRUNCATED).toBe("1");
  expect(Number(capped.PAPERCLIP_WORKSPACES_COUNT)).toBeLessThan(large.length);
});

test("sessions cannot resume on a different project cwd or without a pinned cwd", () => {
  const run = context("project_primary", "/new");
  expect(resolveHermesSessionId({ sessionId: "s1", cwd: "/old" }, run, "/new", true)).toBeUndefined();
  expect(resolveHermesSessionId({ sessionId: "s1" }, run, "/new", true)).toBeUndefined();
  expect(resolveHermesSessionId({ sessionId: "s1", cwd: "/new" }, run, "/new", true)).toBe("s1");
  expect(resolveHermesSessionId({ sessionId: "s1" }, {}, ".", true)).toBe("s1");
  expect(resolveHermesSessionId({ sessionId: "s1" }, {}, ".", false)).toBeUndefined();
});

test("new reserved workspace env keys from future versions do not leak across runs", () => {
  const env = buildHermesWorkspaceEnv({
    PAPERCLIP_WORKSPACE_FUTURE_SECRET: "stale-secret",
    PAPERCLIP_WORKSPACES_OTHER_METADATA: "stale",
    AGENT_HOME: "/former",
    NORMAL_VAR: "preserve",
  }, {}, ".");
  expect(env.PAPERCLIP_WORKSPACE_FUTURE_SECRET).toBeUndefined();
  expect(env.PAPERCLIP_WORKSPACES_OTHER_METADATA).toBeUndefined();
  expect(env.AGENT_HOME).toBeUndefined();
  expect(env.NORMAL_VAR).toBe("preserve");
});

test("project-linked run cannot use an agent cwd when no workspace context arrived", () => {
  expect(() => resolveHermesCwd({ cwd: "/agent/static" }, { projectId: "linked-project" })).toThrow();
  expect(() => resolveHermesCwd({ cwd: "/agent/static" }, { projectId: "linked-project", paperclipWorkspace: {} })).toThrow();
});
