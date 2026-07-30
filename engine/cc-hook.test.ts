import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK_PATH = join(import.meta.dirname, "cc-hook.ts");

function runHook(input: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", HOOK_PATH], {
    input,
    encoding: "utf8",
  });
}

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-hook-"));
  return dir;
}

function writePayload(toolName: string, toolInput: unknown, cwd?: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    ...(cwd === undefined ? {} : { cwd }),
  });
}

test("write of a new python file with an added comment blocks", () => {
  const dir = newTempDir();
  const payload = writePayload("Write", { file_path: "app/foo.py", content: "x = 1\n# noise\n" }, dir);

  const res = runHook(payload);

  assert.equal(res.status, 2);
  assert.ok(res.stderr.includes("Blocked"), `expected Blocked in stderr: ${res.stderr}`);
  assert.equal(res.stdout, "");
});

test("write of a high-cyclomatic-complexity python function nudges allow", () => {
  const dir = newTempDir();
  const content = [
    "def flagged(x):",
    "    if x == 1: return 'one'",
    "    elif x == 2: return 'two'",
    "    elif x == 3: return 'three'",
    "    elif x == 4: return 'four'",
    "    elif x == 5: return 'five'",
    "    elif x == 6: return 'six'",
    "    elif x == 7: return 'seven'",
    "    elif x == 8: return 'eight'",
    "    elif x == 9: return 'nine'",
    "    elif x == 10: return 'ten'",
    "    elif x == 11: return 'eleven'",
    "    else: return 'other'",
  ].join("\n");
  const payload = writePayload("Write", { file_path: "app/foo.py", content }, dir);

  const res = runHook(payload);

  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("cc"), `expected cc in: ${out.hookSpecificOutput.additionalContext}`);
});

test("write of trivial python passes silently", () => {
  const dir = newTempDir();
  const payload = writePayload("Write", { file_path: "app/foo.py", content: "x = 1" }, dir);

  const res = runHook(payload);

  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
});

test("multiedit adding a comment to a clean on-disk file blocks", () => {
  const dir = newTempDir();
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "m.py"), "x = 1\n");
  const payload = writePayload(
    "MultiEdit",
    { file_path: "app/m.py", edits: [{ old_string: "x = 1", new_string: "x = 1\n# noise" }] },
    dir,
  );

  const res = runHook(payload);

  assert.equal(res.status, 2);
  assert.ok(res.stderr.length > 0, "expected non-empty stderr");
  assert.equal(res.stdout, "");
});

test("edit to an unknown-extension file passes silently", () => {
  const dir = newTempDir();
  writeFileSync(join(dir, "README.md"), "hello\n");
  const payload = writePayload(
    "Edit",
    { file_path: "README.md", old_string: "hello", new_string: "hi" },
    dir,
  );

  const res = runHook(payload);

  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
});

test("a non-edit tool passes silently", () => {
  const payload = writePayload("Bash", { command: "ls" });

  const res = runHook(payload);

  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
});

test("malformed json passes silently (fail open)", () => {
  const res = runHook("{ not json");

  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
});
