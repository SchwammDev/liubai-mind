import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const HOOK_PATH = join(import.meta.dirname, "cc-hook.ts");

const HIGH_CC_PYTHON = [
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

function runHook(input: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, ["--experimental-strip-types", HOOK_PATH], { input, encoding: "utf8" });
}

function newTempDir(): string {
  return mkdtempSync(join(tmpdir(), "cc-hook-"));
}

function writePayload(toolName: string, toolInput: unknown, cwd?: string): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    ...(cwd === undefined ? {} : { cwd }),
  });
}

function writeCleanFile(dir: string, relPath: string, content: string): void {
  const full = join(dir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function runWrite(filePath: string, content: string): SpawnSyncReturns<string> {
  return runHook(writePayload("Write", { file_path: filePath, content }, newTempDir()));
}

function assertPassedSilently(res: SpawnSyncReturns<string>): void {
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
}

function assertBlocked(res: SpawnSyncReturns<string>): void {
  assert.equal(res.status, 2);
  assert.equal(res.stdout, "");
}

function assertAllowedWithContext(res: SpawnSyncReturns<string>, needle: string): void {
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  const output = JSON.parse(res.stdout).hookSpecificOutput;
  assert.equal(output.permissionDecision, "allow");
  assert.ok(output.additionalContext.includes(needle), `expected ${needle} in: ${output.additionalContext}`);
}

test("write of a new python file with an added comment blocks", () => {
  const res = runWrite("app/foo.py", "x = 1\n# noise\n");

  assertBlocked(res);
  assert.ok(res.stderr.includes("Blocked"), `expected Blocked in stderr: ${res.stderr}`);
});

test("write of a high-cyclomatic-complexity python function nudges allow", () => {
  const res = runWrite("app/foo.py", HIGH_CC_PYTHON);

  assertAllowedWithContext(res, "cc");
});

test("write of trivial python passes silently", () => {
  const res = runWrite("app/foo.py", "x = 1");

  assertPassedSilently(res);
});

test("multiedit adding a comment to a clean on-disk file blocks", () => {
  const dir = newTempDir();
  writeCleanFile(dir, "app/m.py", "x = 1\n");
  const payload = writePayload("MultiEdit", { file_path: "app/m.py", edits: [{ old_string: "x = 1", new_string: "x = 1\n# noise" }] }, dir);

  const res = runHook(payload);

  assertBlocked(res);
  assert.ok(res.stderr.length > 0, "expected non-empty stderr");
});

test("edit to an unknown-extension file passes silently", () => {
  const dir = newTempDir();
  writeCleanFile(dir, "README.md", "hello\n");
  const payload = writePayload("Edit", { file_path: "README.md", old_string: "hello", new_string: "hi" }, dir);

  const res = runHook(payload);

  assertPassedSilently(res);
});

test("a non-edit tool passes silently", () => {
  const res = runHook(writePayload("Bash", { command: "ls" }));

  assertPassedSilently(res);
});

test("malformed json passes silently (fail open)", () => {
  const res = runHook("{ not json");

  assertPassedSilently(res);
});
