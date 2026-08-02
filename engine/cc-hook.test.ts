import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { mapChange } from "./cc-hook.ts";

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

function mapTool(toolName: unknown, toolInput: unknown): ReturnType<typeof mapChange> {
  return mapChange({ tool_name: toolName, tool_input: toolInput });
}

test("an edit tool payload with a non-object tool input is ignored", () => {
  assert.equal(mapTool("Write", null), null);
});

test("a Write payload maps to a write change carrying its path and content", () => {
  const change = mapTool("Write", { file_path: "a.py", content: "x = 1" });

  assert.deepEqual(change, { kind: "write", path: "a.py", content: "x = 1" });
});

test("a Write payload missing its path or its content is ignored", () => {
  assert.equal(mapTool("Write", { file_path: "a.py" }), null);
  assert.equal(mapTool("Write", { content: "x = 1" }), null);
});

test("an Edit payload maps to a single-edit change", () => {
  const change = mapTool("Edit", { file_path: "a.py", old_string: "a", new_string: "b" });

  assert.deepEqual(change, { kind: "edit", path: "a.py", edits: [{ oldText: "a", newText: "b" }] });
});

test("an Edit payload missing its path, old string, or new string is ignored", () => {
  assert.equal(mapTool("Edit", { old_string: "a", new_string: "b" }), null);
  assert.equal(mapTool("Edit", { file_path: "a.py", new_string: "b" }), null);
  assert.equal(mapTool("Edit", { file_path: "a.py", old_string: "a" }), null);
});

test("a MultiEdit payload maps to an edit change preserving every edit in order", () => {
  const edits = [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }];

  const change = mapTool("MultiEdit", { file_path: "a.py", edits });

  assert.deepEqual(change, { kind: "edit", path: "a.py", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] });
});

test("a MultiEdit payload missing its path or with a non-array edits field is ignored", () => {
  assert.equal(mapTool("MultiEdit", { edits: [] }), null);
  assert.equal(mapTool("MultiEdit", { file_path: "a.py", edits: {} }), null);
});

test("a MultiEdit payload with a non-object or incomplete edit entry is ignored", () => {
  assert.equal(mapTool("MultiEdit", { file_path: "a.py", edits: [null] }), null);
  assert.equal(mapTool("MultiEdit", { file_path: "a.py", edits: [{ new_string: "b" }] }), null);
  assert.equal(mapTool("MultiEdit", { file_path: "a.py", edits: [{ old_string: "a" }] }), null);
});

test("an unrecognized tool is ignored", () => {
  assert.equal(mapTool("Bash", { command: "ls" }), null);
});
