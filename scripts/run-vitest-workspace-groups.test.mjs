import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(scriptsDir);
const runner = path.join(scriptsDir, "run-vitest-stable.mjs");

function group(name) {
  const result = spawnSync(
    process.execPath,
    [runner, "--mode", "general", "--group", name, "--dry-run"],
    { cwd: root, encoding: "utf8", timeout: 20000, maxBuffer: 5_000_000 },
  );
  assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout}`);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.group, name);
  assert.ok(Array.isArray(plan.workspaceProjects), `${name} must list its projects`);
  return plan.workspaceProjects;
}

test("CI workspaces-c group is recognized and runs the database project", () => {
  assert.deepEqual(group("general-workspaces-c"), ["@paperclipai/db"]);
});

test("CI workspace lanes form a complete, disjoint project partition", () => {
  const a = group("general-workspaces-a");
  const b = group("general-workspaces-b");
  const c = group("general-workspaces-c");
  assert.deepEqual(a, ["@paperclipai/ui", "paperclipai"]);
  assert.deepEqual(c, ["@paperclipai/db"]);
  const combined = [...a, ...b, ...c];
  assert.equal(new Set(combined).size, combined.length, "no package runs twice across lanes");
  const source = readFileSync(runner, "utf8");
  const declaration = source.match(/const nonServerProjects = \[([\s\S]*?)\];/);
  assert.ok(declaration, "project manifest must remain explicit");
  const expected = Array.from(declaration[1].matchAll(/"([^"]+)"/g), (match) => match[1]);
  assert.deepEqual([...combined].sort(), [...expected].sort(), "no workspace project may disappear");
});
