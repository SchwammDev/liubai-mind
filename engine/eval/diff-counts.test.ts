import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDiffCounts, sourceDiffCounts } from "./diff-counts.ts";

test("computeDiffCounts_reports_only_added_lines_when_lines_are_appended", () => {
  const counts = computeDiffCounts({ "a.ts": "one\ntwo\n" }, { "a.ts": "one\ntwo\nthree\nfour\n" });

  assert.deepEqual(counts, { linesAdded: 2, linesRemoved: 0 });
});

test("computeDiffCounts_reports_only_removed_lines_when_lines_are_deleted", () => {
  const counts = computeDiffCounts({ "a.ts": "one\ntwo\nthree\nfour\n" }, { "a.ts": "one\ntwo\n" });

  assert.deepEqual(counts, { linesAdded: 0, linesRemoved: 2 });
});

test("computeDiffCounts_counts_every_line_of_a_newly_created_file_as_added", () => {
  const counts = computeDiffCounts({ "a.ts": "one\n" }, { "a.ts": "one\n", "b.ts": "x\ny\nz\n" });

  assert.deepEqual(counts, { linesAdded: 3, linesRemoved: 0 });
});

test("computeDiffCounts_counts_every_line_of_a_file_dropped_from_final_as_removed", () => {
  const counts = computeDiffCounts({ "a.ts": "one\n", "b.ts": "x\ny\nz\n" }, { "a.ts": "one\n" });

  assert.deepEqual(counts, { linesAdded: 0, linesRemoved: 3 });
});

test("computeDiffCounts_counts_a_modified_line_as_one_removed_and_one_added", () => {
  const counts = computeDiffCounts({ "a.ts": "one\n" }, { "a.ts": "two\n" });

  assert.deepEqual(counts, { linesAdded: 1, linesRemoved: 1 });
});

test("computeDiffCounts_sums_added_and_removed_lines_across_every_file", () => {
  const counts = computeDiffCounts({ "a.ts": "one\ntwo\n", "b.ts": "x\n" }, { "a.ts": "one\ntwo\nthree\n", "b.ts": "y\n" });

  assert.deepEqual(counts, { linesAdded: 2, linesRemoved: 1 });
});

test("computeDiffCounts_reports_zero_added_and_removed_for_byte_identical_files", () => {
  const counts = computeDiffCounts({ "a.ts": "one\ntwo\n" }, { "a.ts": "one\ntwo\n" });

  assert.deepEqual(counts, { linesAdded: 0, linesRemoved: 0 });
});

test("sourceDiffCounts_ignores_a_package_lock_json_added_by_the_solution_for_a_typescript_case", () => {
  const counts = sourceDiffCounts({ "a.ts": "one\n" }, { "a.ts": "one\n", "package-lock.json": "{\n  \"x\": 1\n}\n" }, "typescript");

  assert.deepEqual(counts, { linesAdded: 0, linesRemoved: 0 });
});

test("sourceDiffCounts_ignores_a_scratch_file_added_under_playground_for_a_typescript_case", () => {
  const counts = sourceDiffCounts({ "a.ts": "one\n" }, { "a.ts": "one\n", "playground/scratch.ts": "x\ny\n" }, "typescript");

  assert.deepEqual(counts, { linesAdded: 0, linesRemoved: 0 });
});

test("sourceDiffCounts_ignores_a_compiled_js_file_while_still_counting_ts_files_for_a_typescript_case", () => {
  const counts = sourceDiffCounts({ "a.ts": "one\n" }, { "a.ts": "one\ntwo\n", "a.js": "var one;\nvar two;\n" }, "typescript");

  assert.deepEqual(counts, { linesAdded: 1, linesRemoved: 0 });
});

test("sourceDiffCounts_counts_a_new_py_source_file_for_a_python_case", () => {
  const counts = sourceDiffCounts({ "a.py": "one\n" }, { "a.py": "one\n", "b.py": "x\ny\n" }, "python");

  assert.deepEqual(counts, { linesAdded: 2, linesRemoved: 0 });
});

test("sourceDiffCounts_ignores_litter_present_in_the_earlier_files_but_absent_from_final_files", () => {
  const counts = sourceDiffCounts({ "a.ts": "one\n", "package-lock.json": "{\n  \"x\": 1\n}\n" }, { "a.ts": "one\n" }, "typescript");

  assert.deepEqual(counts, { linesAdded: 0, linesRemoved: 0 });
});
