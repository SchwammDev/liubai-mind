import { test } from "node:test";
import assert from "node:assert/strict";

import { crapScore, flagCrapViolations } from "./crap.ts";
import type { CrapInput } from "./crap.ts";

function fn(name: string, startLine: number, endLine: number, cc: number): CrapInput["functions"][number] {
  return { name, startLine, endLine, cc };
}

function input(over: Partial<CrapInput> & Pick<CrapInput, "functions" | "hunks" | "coverage">): CrapInput {
  return { path: "app/foo.ts", threshold: 10, ...over };
}

test("crap_score_applies_cc_squared_times_uncovered_cubed_plus_cc", () => {
  assert.equal(crapScore(4, 0), 4 * 4 * 1 + 4);
  assert.equal(crapScore(2, 1), 0 + 2);
  assert.equal(crapScore(5, 0.5), 25 * 0.125 + 5);
});

test("function_outside_all_hunks_is_not_evaluated", () => {
  const res = flagCrapViolations(input({
    functions: [fn("f", 1, 5, 20)],
    hunks: [[10, 15]],
    coverage: "new",
  }));

  assert.deepEqual(res, []);
});

test("function_intersecting_a_hunk_is_evaluated", () => {
  const res = flagCrapViolations(input({
    functions: [fn("f", 1, 5, 20)],
    hunks: [[5, 10]],
    coverage: "new",
  }));

  assert.equal(res.length, 1);
  assert.equal(res[0]!.name, "f");
});

test("coverage_is_executed_over_coverable_lines_within_function_span", () => {
  const res = flagCrapViolations(input({
    functions: [fn("f", 2, 6, 10)],
    hunks: [[1, 20]],
    coverage: { executed: [2, 3, 7], missing: [5] },
  }));

  assert.equal(res[0]!.cov, 2 / 3);
});

test("function_with_no_coverable_lines_defaults_to_full_coverage", () => {
  const res = flagCrapViolations(input({
    functions: [fn("f", 2, 4, 11)],
    hunks: [[1, 10]],
    coverage: { executed: [1, 5], missing: [6] },
  }));

  assert.equal(res[0]!.cov, 1.0);
});

test("new_file_coverage_is_zero", () => {
  const res = flagCrapViolations(input({
    functions: [fn("f", 1, 3, 10)],
    hunks: [[1, 3]],
    coverage: "new",
  }));

  assert.equal(res[0]!.cov, 0.0);
});

test("score_at_threshold_is_not_a_violation", () => {
  assert.equal(flagCrapViolations(input({
    functions: [fn("f", 1, 1, 10)],
    hunks: [[1, 1]],
    coverage: { executed: [], missing: [] },
    threshold: 10,
  })).length, 0);
});

test("score_above_threshold_is_a_violation", () => {
  assert.equal(flagCrapViolations(input({
    functions: [fn("f", 1, 1, 11)],
    hunks: [[1, 1]],
    coverage: { executed: [], missing: [] },
    threshold: 10,
  })).length, 1);
});

test("violation_reports_cc_cov_and_crap", () => {
  const res = flagCrapViolations(input({
    functions: [fn("f", 1, 4, 6)],
    hunks: [[1, 4]],
    coverage: { executed: [1], missing: [2, 3, 4] },
    threshold: 10,
  }));

  assert.deepEqual(res[0], { name: "f", cc: 6, cov: 0.25, crap: 6 * 6 * 0.75 ** 3 + 6 });
});

test("hunk_abutting_function_end_is_an_intersection", () => {
  assert.equal(flagCrapViolations(input({
    functions: [fn("f", 1, 5, 20)],
    hunks: [[5, 5]],
    coverage: "new",
  })).length, 1);
});
