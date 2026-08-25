import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { snapshotExtras, SNAPSHOT_FILE_CAP_BYTES, SNAPSHOT_TOTAL_CAP_BYTES } from "./snapshot.ts";
import type { WorkDirSnapshot } from "./snapshot.ts";

const ROOT_ALPHA = { path: "alpha.txt", content: "alpha content" };
const NESTED_UTIL = { path: "lib/util.py", content: "util content" };
const ROOT_ZETA = { path: "zeta.txt", content: "zeta content" };

const FILLER_COUNT = SNAPSHOT_TOTAL_CAP_BYTES / SNAPSHOT_FILE_CAP_BYTES;
const FILLER_CONTENT = "x".repeat(SNAPSHOT_FILE_CAP_BYTES);

function tempWorkDir(): string {
  return mkdtempSync(join(tmpdir(), "snapshot-"));
}

function writeUtf8(dir: string, relPath: string, content: string): void {
  const fullPath = join(dir, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function writeBinary(dir: string, relPath: string, bytes: number[]): void {
  const fullPath = join(dir, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, Buffer.from(bytes));
}

function fillerFileName(index: number): string {
  return `a${String(index).padStart(2, "0")}.txt`;
}

function fixtureWithNestedAndRootFiles(): string {
  const workDir = tempWorkDir();
  writeUtf8(workDir, ROOT_ALPHA.path, ROOT_ALPHA.content);
  writeUtf8(workDir, NESTED_UTIL.path, NESTED_UTIL.content);
  writeUtf8(workDir, ROOT_ZETA.path, ROOT_ZETA.content);
  return workDir;
}

function fixtureWithIgnoredDirectoriesAndPycFiles(): string {
  const workDir = tempWorkDir();
  writeUtf8(workDir, "node_modules/x.js", "module content");
  writeUtf8(workDir, "__pycache__/m.cpython-312.pyc", "bytecode");
  writeUtf8(workDir, "stray.pyc", "root bytecode");
  return workDir;
}

function fixtureFillingTheTotalBudgetThenOneMore(): string {
  const workDir = tempWorkDir();
  for (let i = 0; i < FILLER_COUNT; i += 1) writeUtf8(workDir, fillerFileName(i), FILLER_CONTENT);
  writeUtf8(workDir, "z_extra.txt", "tips it over the budget");
  return workDir;
}

function fixtureWithSymlinksToFileAndDirectory(): string {
  const workDir = tempWorkDir();
  writeUtf8(workDir, "target.txt", "target content");
  writeUtf8(workDir, "target_dir/inner.txt", "inner content");
  symlinkSync(join(workDir, "target.txt"), join(workDir, "link_to_file.txt"));
  symlinkSync(join(workDir, "target_dir"), join(workDir, "link_to_dir"));
  return workDir;
}

function assertFilesCapturedInOrder(files: Record<string, string>, entries: { path: string; content: string }[]): void {
  assert.deepEqual(Object.keys(files), entries.map((entry) => entry.path));
  for (const { path, content } of entries) assert.equal(files[path], content);
}

function assertDroppedOnly(snapshot: WorkDirSnapshot, paths: string[]): void {
  assert.deepEqual(snapshot.dropped, paths);
  assert.deepEqual(snapshot.files, {});
}

function assertOnlyFillerFilesCaptured(files: Record<string, string>): void {
  assert.equal(Object.keys(files).length, FILLER_COUNT);
  assert.equal(files[fillerFileName(0)], FILLER_CONTENT);
}

function assertFileNotCaptured(files: Record<string, string>, relPath: string): void {
  assert.equal(relPath in files, false);
}

function assertFileCaptured(files: Record<string, string>, relPath: string, content: string): void {
  assert.equal(files[relPath], content);
}

function assertSymlinksDroppedWithoutFollowing(snapshot: WorkDirSnapshot): void {
  assert.deepEqual(snapshot.dropped, ["link_to_dir", "link_to_file.txt"]);
  assertFileNotCaptured(snapshot.files, "link_to_file.txt");
  assertFileNotCaptured(snapshot.files, "link_to_dir/inner.txt");
  assertFileCaptured(snapshot.files, "target_dir/inner.txt", "inner content");
}

test("snapshotExtras_captures_extra_files_recursively_in_lexicographic_key_order", () => {
  const workDir = fixtureWithNestedAndRootFiles();

  const snapshot = snapshotExtras(workDir, new Set());

  assertFilesCapturedInOrder(snapshot.files, [ROOT_ALPHA, NESTED_UTIL, ROOT_ZETA]);
});

test("snapshotExtras_never_captures_or_lists_ignored_directories_and_pyc_files", () => {
  const workDir = fixtureWithIgnoredDirectoriesAndPycFiles();

  const snapshot = snapshotExtras(workDir, new Set());

  assertDroppedOnly(snapshot, []);
});

test("snapshotExtras_drops_a_root_binary_file_and_lists_it_individually", () => {
  const workDir = tempWorkDir();
  writeBinary(workDir, "blob.bin", [0, 1, 2, 3]);

  const snapshot = snapshotExtras(workDir, new Set());

  assertDroppedOnly(snapshot, ["blob.bin"]);
});

test("snapshotExtras_drops_a_file_over_the_per_file_cap", () => {
  const workDir = tempWorkDir();
  writeUtf8(workDir, "over_cap.txt", "a".repeat(SNAPSHOT_FILE_CAP_BYTES + 1));

  const snapshot = snapshotExtras(workDir, new Set());

  assertDroppedOnly(snapshot, ["over_cap.txt"]);
});

test("snapshotExtras_drops_extras_past_the_total_budget_in_walk_order", () => {
  const workDir = fixtureFillingTheTotalBudgetThenOneMore();

  const snapshot = snapshotExtras(workDir, new Set());

  assertOnlyFillerFilesCaptured(snapshot.files);
  assert.deepEqual(snapshot.dropped, ["z_extra.txt"]);
});

test("snapshotExtras_collapses_dropped_paths_below_a_directory_into_one_entry", () => {
  const workDir = tempWorkDir();
  writeBinary(workDir, "data/bin1.bin", [0, 1]);
  writeBinary(workDir, "data/bin2.bin", [0, 2]);

  const snapshot = snapshotExtras(workDir, new Set());

  assertDroppedOnly(snapshot, ["data/"]);
});

test("snapshotExtras_records_a_symlink_as_dropped_without_following_it", () => {
  const workDir = fixtureWithSymlinksToFileAndDirectory();

  const snapshot = snapshotExtras(workDir, new Set());

  assertSymlinksDroppedWithoutFollowing(snapshot);
});

test("snapshotExtras_skips_declared_paths_leaving_them_to_the_copy_plan_reader", () => {
  const workDir = tempWorkDir();
  writeUtf8(workDir, "declared.ts", "declared content");

  const snapshot = snapshotExtras(workDir, new Set(["declared.ts"]));

  assertDroppedOnly(snapshot, []);
});
