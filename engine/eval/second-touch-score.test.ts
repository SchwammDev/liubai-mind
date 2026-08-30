import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeDiffCounts,
  judgeSecondTouchRows,
  aggregateSecondTouch,
  formatSecondTouchMarkdown,
  touchKindOf,
  routeScore,
  runSecondTouchScore,
} from "./second-touch-score.ts";
import type { JudgedSecondTouchRow, SecondTouchSummaryRow, SecondTouchVerdict } from "./second-touch-score.ts";
import type { RawRow, Provenance, SecondTouchInfo } from "./eval-contract.ts";
import { RULE } from "../contract.ts";
import type { RuleName } from "../contract.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function identitySource(): string {
  return "export function f(x: number): number {\n  return x;\n}\n";
}

function extendedSource(): string {
  return "export function f(x: number, double?: boolean): number {\n  if (double) {\n    return x * 2;\n  }\n  return x;\n}\n";
}

function touchedButUnextendedSource(): string {
  return `${identitySource()}// noop\n`;
}

function regressedSource(): string {
  return "export function f(x: number): number {\n  return x + 1;\n}\n";
}

const GARBAGE_SOURCE = ")))garbage(((";

function extendableCorpusDir(caseId: string): string {
  const corpusDir = tempDir("eval-second-touch-score-corpus-");
  const caseDir = join(corpusDir, caseId);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(
    join(caseDir, "manifest.json"),
    JSON.stringify({
      id: caseId,
      lang: "typescript",
      files: ["thing.ts.case"],
      entry: "thing.ts",
      entrySymbol: "f",
      task: "Improve thing.ts. Keep the public function signature and behavior unchanged.",
      tier: "easy",
      baseline: { decisionPoints: 0, functions: 1, silentHandlers: 0 },
    }),
  );
  writeFileSync(join(caseDir, "probes.json"), JSON.stringify([{ args: [1], returns: 1 }]));
  writeFileSync(
    join(caseDir, "extension.json"),
    JSON.stringify({
      task: "Add an optional double parameter that doubles the result when true.",
      probes: [{ args: [2, true], returns: 4 }],
    }),
  );
  writeFileSync(join(caseDir, "thing.ts.case"), identitySource());
  return corpusDir;
}

function identityObjectSource(): string {
  return "export function f(x: number): { value: number } {\n  return { value: x };\n}\n";
}

function shapeWideningObjectSource(): string {
  return [
    "export function f(x: number, double?: boolean): { value: number; tag: null } {",
    "  const value = double ? x * 2 : x;",
    "  return { value, tag: null };",
    "}",
    "",
  ].join("\n");
}

function extendableObjectCorpusDir(caseId: string): string {
  const corpusDir = tempDir("eval-second-touch-score-corpus-");
  const caseDir = join(corpusDir, caseId);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(
    join(caseDir, "manifest.json"),
    JSON.stringify({
      id: caseId,
      lang: "typescript",
      files: ["thing.ts.case"],
      entry: "thing.ts",
      entrySymbol: "f",
      task: "Improve thing.ts. Keep the public function signature and behavior unchanged.",
      tier: "easy",
      baseline: { decisionPoints: 0, functions: 1, silentHandlers: 0 },
    }),
  );
  writeFileSync(join(caseDir, "probes.json"), JSON.stringify([{ args: [1], returns: { value: 1 } }]));
  writeFileSync(
    join(caseDir, "extension.json"),
    JSON.stringify({
      task: "Add an optional double parameter that doubles the result when true.",
      probes: [{ args: [2, true], returns: { value: 4 } }],
    }),
  );
  writeFileSync(join(caseDir, "thing.ts.case"), identityObjectSource());
  return corpusDir;
}

function noExtensionCorpusDir(caseId: string): string {
  const corpusDir = tempDir("eval-second-touch-score-corpus-");
  const caseDir = join(corpusDir, caseId);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(
    join(caseDir, "manifest.json"),
    JSON.stringify({
      id: caseId,
      lang: "typescript",
      files: ["thing.ts.case"],
      entry: "thing.ts",
      entrySymbol: "f",
      task: "Improve thing.ts. Keep the public function signature and behavior unchanged.",
      tier: "easy",
      baseline: { decisionPoints: 0, functions: 1, silentHandlers: 0 },
    }),
  );
  writeFileSync(join(caseDir, "probes.json"), JSON.stringify([{ args: [1], returns: 1 }]));
  writeFileSync(join(caseDir, "thing.ts.case"), identitySource());
  return corpusDir;
}

function provenance(over: Partial<Provenance> = {}): Provenance {
  return {
    conditionId: "rails-default",
    phrasingPackHash: null,
    liubaiSha: "abc1234",
    model: "claude-x",
    collectedAt: "2026-08-29T00:00:00.000Z",
    ...over,
  };
}

function sourceRow(caseId: string, over: Partial<RawRow> = {}): RawRow {
  return {
    caseId,
    conditionId: "rails-default",
    rep: 1,
    provenance: provenance(),
    files: { "thing.ts": identitySource() },
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    ...over,
  };
}

function secondTouchInfo(over: Partial<SecondTouchInfo> = {}): SecondTouchInfo {
  return { sourceRun: "source-run", sourceRep: 1, control: false, ...over };
}

function seededRow(caseId: string, over: Partial<RawRow> = {}, infoOver: Partial<SecondTouchInfo> = {}): RawRow {
  return {
    caseId,
    conditionId: "rails-default",
    rep: 1,
    provenance: provenance(),
    files: { "thing.ts": extendedSource() },
    exitCode: 0,
    timedOut: false,
    durationMs: 500,
    secondTouch: secondTouchInfo(infoOver),
    ...over,
  };
}

function controlRow(caseId: string, over: Partial<RawRow> = {}): RawRow {
  return seededRow(caseId, over, { sourceRep: null, control: true });
}

async function judgeOne(corpusDir: string, row: RawRow, sourceRows: RawRow[] = []): Promise<JudgedSecondTouchRow> {
  const judged = await judgeSecondTouchRows([row], sourceRows, corpusDir);
  return judged[0]!;
}

test("judgeSecondTouchRows_classifies_an_agent_errored_row_as_errored_before_any_other_check", async () => {
  const caseId = "second-touch-errored";
  const corpusDir = extendableCorpusDir(caseId);
  const row = seededRow(caseId, { agentError: "boom", files: { "thing.ts": GARBAGE_SOURCE } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "errored");
});

test("judgeSecondTouchRows_classifies_a_missing_entry_file_as_broken", async () => {
  const caseId = "second-touch-missing-entry";
  const corpusDir = extendableCorpusDir(caseId);
  const row = seededRow(caseId, { files: {} });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "broken");
});

test("judgeSecondTouchRows_classifies_an_unparseable_entry_file_as_broken", async () => {
  const caseId = "second-touch-unparseable";
  const corpusDir = extendableCorpusDir(caseId);
  const row = seededRow(caseId, { files: { "thing.ts": GARBAGE_SOURCE } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "broken");
});

test("judgeSecondTouchRows_classifies_a_seeded_row_identical_to_the_source_files_as_untouched", async () => {
  const caseId = "second-touch-untouched-seeded";
  const corpusDir = extendableCorpusDir(caseId);
  const source = sourceRow(caseId, { files: { "thing.ts": touchedButUnextendedSource() } });
  const row = seededRow(caseId, { files: { "thing.ts": touchedButUnextendedSource() } });

  const judged = await judgeOne(corpusDir, row, [source]);

  assert.equal(judged.judge.verdict, "untouched");
});

test("judgeSecondTouchRows_classifies_a_control_row_identical_to_the_pristine_case_files_as_untouched", async () => {
  const caseId = "second-touch-untouched-control";
  const corpusDir = extendableCorpusDir(caseId);
  const row = controlRow(caseId, { files: { "thing.ts": identitySource() } });

  const judged = await judgeOne(corpusDir, row, []);

  assert.equal(judged.judge.verdict, "untouched");
});

test("judgeSecondTouchRows_classifies_a_touched_row_that_fails_the_original_probes_as_regressed", async () => {
  const caseId = "second-touch-regressed";
  const corpusDir = extendableCorpusDir(caseId);
  const row = seededRow(caseId, { files: { "thing.ts": regressedSource() } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "regressed");
});

test("judgeSecondTouchRows_prefers_regressed_over_extension_failed_when_both_probe_sets_fail", async () => {
  const caseId = "second-touch-precedence";
  const corpusDir = extendableCorpusDir(caseId);
  const row = seededRow(caseId, { files: { "thing.ts": regressedSource() } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "regressed");
});

test("judgeSecondTouchRows_prefers_errored_over_broken_when_both_apply", async () => {
  const caseId = "second-touch-errored-and-broken";
  const corpusDir = extendableCorpusDir(caseId);
  const row = seededRow(caseId, { agentError: "boom", files: { "thing.ts": GARBAGE_SOURCE } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "errored");
});

test("judgeSecondTouchRows_classifies_original_probes_green_and_extension_probes_red_as_extension_failed", async () => {
  const caseId = "second-touch-extension-failed";
  const corpusDir = extendableCorpusDir(caseId);
  const row = seededRow(caseId, { files: { "thing.ts": touchedButUnextendedSource() } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId, { files: { "thing.ts": identitySource() } })]);

  assert.equal(judged.judge.verdict, "extension-failed");
});

test("judgeSecondTouchRows_classifies_both_probe_sets_green_as_extended", async () => {
  const caseId = "second-touch-extended";
  const corpusDir = extendableCorpusDir(caseId);
  const row = seededRow(caseId, { files: { "thing.ts": extendedSource() } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "extended");
});

test("judgeSecondTouchRows_classifies_a_solution_that_widens_the_returned_shape_as_extended_not_regressed", async () => {
  const caseId = "second-touch-shape-widening";
  const corpusDir = extendableObjectCorpusDir(caseId);
  const row = seededRow(caseId, { files: { "thing.ts": shapeWideningObjectSource() } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId, { files: { "thing.ts": identityObjectSource() } })]);

  assert.equal(judged.judge.verdict, "extended");
});

test("judgeSecondTouchRows_throws_when_the_row_case_has_no_extension_spec", async () => {
  const caseId = "second-touch-no-extension";
  const corpusDir = noExtensionCorpusDir(caseId);
  const row = seededRow(caseId, { files: { "thing.ts": extendedSource() } });

  await assert.rejects(() => judgeSecondTouchRows([row], [sourceRow(caseId)], corpusDir), /extension/);
});

test("judgeSecondTouchRows_stratifies_a_seeded_row_by_its_source_rows_first_touch_verdict", async () => {
  const caseId = "second-touch-stratify-bar-missed";
  const corpusDir = extendableCorpusDir(caseId);
  const source = sourceRow(caseId, { files: { "thing.ts": touchedButUnextendedSource() } });
  const row = seededRow(caseId, { files: { "thing.ts": extendedSource() } });

  const judged = await judgeOne(corpusDir, row, [source]);

  assert.equal(judged.stratum, "bar-missed");
});

test("judgeSecondTouchRows_stratifies_an_untouched_source_row_as_the_untouched_first_touch_verdict", async () => {
  const caseId = "second-touch-stratify-untouched";
  const corpusDir = extendableCorpusDir(caseId);
  const source = sourceRow(caseId, { files: { "thing.ts": identitySource() } });
  const row = seededRow(caseId, { files: { "thing.ts": extendedSource() } });

  const judged = await judgeOne(corpusDir, row, [source]);

  assert.equal(judged.stratum, "untouched");
});

test("judgeSecondTouchRows_stratifies_every_control_row_into_the_control_stratum", async () => {
  const caseId = "second-touch-stratify-control";
  const corpusDir = extendableCorpusDir(caseId);
  const row = controlRow(caseId, { files: { "thing.ts": extendedSource() } });

  const judged = await judgeOne(corpusDir, row, []);

  assert.equal(judged.stratum, "control");
});

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

function judgedSecondTouchRow(
  conditionId: string,
  caseId: string,
  verdict: SecondTouchVerdict,
  stratum: string,
  over: Partial<RawRow> = {},
  diffCounts: { linesAdded: number; linesRemoved: number } = { linesAdded: 0, linesRemoved: 0 },
): JudgedSecondTouchRow {
  return { row: seededRow(caseId, { conditionId, ...over }), judge: { verdict, ...diffCounts }, stratum };
}

function rollupOf(summary: SecondTouchSummaryRow[], conditionId: string): SecondTouchSummaryRow {
  return summary.find((r) => r.conditionId === conditionId && r.caseId === null && r.stratum === null)!;
}

function stratumRowOf(summary: SecondTouchSummaryRow[], conditionId: string, stratum: string): SecondTouchSummaryRow {
  return summary.find((r) => r.conditionId === conditionId && r.caseId === null && r.stratum === stratum)!;
}

function caseRowOf(summary: SecondTouchSummaryRow[], conditionId: string, caseId: string): SecondTouchSummaryRow {
  return summary.find((r) => r.conditionId === conditionId && r.caseId === caseId)!;
}

function assertRollupCounts(summary: SecondTouchSummaryRow[], conditionId: string, expected: { total: number; extended: number; regressed: number }): void {
  const rollup = rollupOf(summary, conditionId);
  assert.equal(rollup.total, expected.total);
  assert.equal(rollup.counts.extended, expected.extended);
  assert.equal(rollup.counts.regressed, expected.regressed);
}

test("aggregateSecondTouch_rolls_up_verdict_counts_per_condition_across_every_stratum", () => {
  const judged = [
    judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedSecondTouchRow("rails-default", "case-b", "regressed", "gamed"),
    judgedSecondTouchRow("control", "case-a", "untouched", "control"),
  ];

  const summary = aggregateSecondTouch(judged);

  assertRollupCounts(summary, "rails-default", { total: 2, extended: 1, regressed: 1 });
});

function assertStratumTotals(summary: SecondTouchSummaryRow[], conditionId: string, expected: Record<string, number>): void {
  const totals = Object.fromEntries(Object.keys(expected).map((stratum) => [stratum, stratumRowOf(summary, conditionId, stratum).total]));
  assert.deepEqual(totals, expected);
}

test("aggregateSecondTouch_emits_a_row_per_condition_and_source_verdict_stratum", () => {
  const judged = [
    judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedSecondTouchRow("rails-default", "case-b", "regressed", "gamed"),
    judgedSecondTouchRow("rails-default", "case-c", "untouched", "control"),
  ];

  const summary = aggregateSecondTouch(judged);

  assertStratumTotals(summary, "rails-default", { "genuine-fix": 1, gamed: 1, control: 1 });
});

test("aggregateSecondTouch_keeps_the_control_stratum_separate_from_seeded_strata", () => {
  const judged = [
    judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedSecondTouchRow("rails-default", "case-a", "untouched", "control"),
  ];

  const summary = aggregateSecondTouch(judged);

  assert.equal(stratumRowOf(summary, "rails-default", "control").counts.untouched, 1);
  assert.equal(stratumRowOf(summary, "rails-default", "genuine-fix").counts.extended, 1);
});

function assertCaseDetailCounts(summary: SecondTouchSummaryRow[], conditionId: string, caseId: string, expected: { total: number; extended: number; regressed: number }): void {
  const detail = caseRowOf(summary, conditionId, caseId);
  assert.equal(detail.total, expected.total);
  assert.equal(detail.counts.extended, expected.extended);
  assert.equal(detail.counts.regressed, expected.regressed);
}

test("aggregateSecondTouch_emits_a_case_detail_row_aggregated_across_strata", () => {
  const judged = [
    judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedSecondTouchRow("rails-default", "case-a", "regressed", "control"),
  ];

  const summary = aggregateSecondTouch(judged);

  assertCaseDetailCounts(summary, "rails-default", "case-a", { total: 2, extended: 1, regressed: 1 });
});

test("aggregateSecondTouch_computes_extension_success_rate_over_non_errored_rows", () => {
  const judged = [
    judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedSecondTouchRow("rails-default", "case-b", "regressed", "genuine-fix"),
    judgedSecondTouchRow("rails-default", "case-c", "errored", "genuine-fix"),
  ];

  const summary = aggregateSecondTouch(judged);

  assert.equal(rollupOf(summary, "rails-default").extensionSuccessRate, 50);
});

test("aggregateSecondTouch_reports_null_extension_success_rate_when_every_row_errored", () => {
  const judged = [judgedSecondTouchRow("rails-default", "case-a", "errored", "genuine-fix")];

  const summary = aggregateSecondTouch(judged);

  assert.equal(rollupOf(summary, "rails-default").extensionSuccessRate, null);
});

test("aggregateSecondTouch_means_lines_added_and_lines_removed_across_the_bucket", () => {
  const judged = [
    judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix", {}, { linesAdded: 4, linesRemoved: 2 }),
    judgedSecondTouchRow("rails-default", "case-b", "extended", "genuine-fix", {}, { linesAdded: 8, linesRemoved: 6 }),
  ];

  const summary = aggregateSecondTouch(judged);

  const rollup = rollupOf(summary, "rails-default");
  assert.equal(rollup.meanLinesAdded, 6);
  assert.equal(rollup.meanLinesRemoved, 4);
});

function railFirings(over: Partial<Record<RuleName, number>> = {}): Record<RuleName, number> {
  const base = Object.fromEntries(Object.values(RULE).map((rule) => [rule, 0])) as Record<RuleName, number>;
  return { ...base, ...over };
}

function assertCostSummary(summary: SecondTouchSummaryRow[], conditionId: string, expected: { meanTurns: number | null; meanRailFiringsTotal: number | null; costAvailable: number }): void {
  const rollup = rollupOf(summary, conditionId);
  assert.equal(rollup.meanTurns, expected.meanTurns);
  assert.equal(rollup.meanRailFiringsTotal, expected.meanRailFiringsTotal);
  assert.equal(rollup.costAvailable, expected.costAvailable);
}

test("aggregateSecondTouch_means_turns_and_total_rail_firings_only_over_rows_that_report_them", () => {
  const judged = [
    judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix", { turns: 4, railFirings: railFirings({ cc: 2, "discourage-comments": 1 }) }),
    judgedSecondTouchRow("rails-default", "case-b", "extended", "genuine-fix", {}),
  ];

  const summary = aggregateSecondTouch(judged);

  assertCostSummary(summary, "rails-default", { meanTurns: 4, meanRailFiringsTotal: 3, costAvailable: 1 });
});

test("aggregateSecondTouch_reports_null_not_zero_for_cost_fields_when_no_row_in_the_bucket_reports_them", () => {
  const judged = [judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix", {})];

  const summary = aggregateSecondTouch(judged);

  assertCostSummary(summary, "rails-default", { meanTurns: null, meanRailFiringsTotal: null, costAvailable: 0 });
});

test("aggregateSecondTouch_stamps_every_row_as_second_touch", () => {
  const judged = [judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix")];

  const summary = aggregateSecondTouch(judged);

  assert.ok(summary.every((row) => row.touch === "second"));
});

test("formatSecondTouchMarkdown_renders_a_dash_for_null_cost_fields_never_a_zero", () => {
  const judged = [judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix")];
  const summary = aggregateSecondTouch(judged);

  const table = formatSecondTouchMarkdown(summary);

  assert.match(table, /\| rails-default \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 100\.0% \| 0\.0 \| 0\.0 \| - \| - \|/);
});

test("formatSecondTouchMarkdown_includes_stratum_rollups_suffixed_with_the_stratum_name", () => {
  const judged = [judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix")];
  const summary = aggregateSecondTouch(judged);

  const table = formatSecondTouchMarkdown(summary);

  assert.match(table, /\| rails-default \[genuine-fix\] \|/);
});

test("formatSecondTouchMarkdown_excludes_per_case_detail_rows", () => {
  const judged = [judgedSecondTouchRow("rails-default", "case-a", "extended", "genuine-fix")];
  const summary = aggregateSecondTouch(judged);

  const table = formatSecondTouchMarkdown(summary);

  assert.equal(table.split("\n").length, 4);
});

function writeRawJsonl(dir: string, rows: RawRow[]): void {
  writeFileSync(join(dir, "raw.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("touchKindOf_reports_first_touch_when_no_row_carries_secondTouch", () => {
  const kind = touchKindOf([sourceRow("case-a")]);

  assert.deepEqual(kind, { kind: "first" });
});

test("touchKindOf_reports_second_touch_and_the_shared_source_run_when_every_row_carries_secondTouch", () => {
  const kind = touchKindOf([seededRow("case-a"), controlRow("case-a")]);

  assert.deepEqual(kind, { kind: "second", sourceRun: "source-run" });
});

test("touchKindOf_errors_when_a_run_mixes_first_touch_and_second_touch_rows", () => {
  const kind = touchKindOf([sourceRow("case-a"), seededRow("case-a")]);

  assert.ok("error" in kind);
});

test("touchKindOf_errors_when_second_touch_rows_reference_more_than_one_source_run", () => {
  const kind = touchKindOf([seededRow("case-a", {}, { sourceRun: "run-x" }), seededRow("case-a", {}, { sourceRun: "run-y" })]);

  assert.ok("error" in kind);
});

function writeSourceRun(runsRoot: string, name: string, rows: RawRow[]): void {
  const dir = join(runsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeRawJsonl(dir, rows);
}

function assertScoredAsFirstTouch(result: { status: number; stdout: string }, runDir: string): void {
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\| condition \|/);
  assert.ok(existsSync(join(runDir, "summary.jsonl")));
}

test("routeScore_routes_a_first_touch_run_to_runScore_unchanged", async () => {
  const runsRoot = tempDir("eval-score-router-runs-");
  const runDir = join(runsRoot, "target");
  mkdirSync(runDir, { recursive: true });
  const corpusDir = extendableCorpusDir("second-touch-router-case");
  writeRawJsonl(runDir, [sourceRow("second-touch-router-case", { files: { "thing.ts": extendedSource() } })]);

  const result = await routeScore({ runDir, corpusDir, repoRoot: join(import.meta.dirname, "..", "..") }, runsRoot);

  assertScoredAsFirstTouch(result, runDir);
});

test("routeScore_routes_a_second_touch_run_to_second_touch_scoring", async () => {
  const runsRoot = tempDir("eval-score-router-runs-");
  const caseId = "second-touch-router-second";
  const corpusDir = extendableCorpusDir(caseId);
  writeSourceRun(runsRoot, "source-run", [sourceRow(caseId)]);
  const runDir = join(runsRoot, "target");
  mkdirSync(runDir, { recursive: true });
  writeRawJsonl(runDir, [seededRow(caseId, { files: { "thing.ts": extendedSource() } })]);

  const result = await routeScore({ runDir, corpusDir, repoRoot: join(import.meta.dirname, "..", "..") }, runsRoot);

  const summary = readFileSync(join(runDir, "summary.jsonl"), "utf8");
  assert.equal(result.status, 0);
  assert.ok(summary.includes('"touch":"second"'));
});

test("routeScore_fails_a_run_that_mixes_first_touch_and_second_touch_rows", async () => {
  const runsRoot = tempDir("eval-score-router-runs-");
  const caseId = "second-touch-router-mixed";
  const corpusDir = extendableCorpusDir(caseId);
  const runDir = join(runsRoot, "target");
  mkdirSync(runDir, { recursive: true });
  writeRawJsonl(runDir, [sourceRow(caseId), seededRow(caseId)]);

  const result = await routeScore({ runDir, corpusDir, repoRoot: join(import.meta.dirname, "..", "..") }, runsRoot);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /mixes first-touch and second-touch/);
});

function assertSummaryHasBothStrata(result: { status: number }, runDir: string): void {
  assert.equal(result.status, 0);
  const summaryLines = readFileSync(join(runDir, "summary.jsonl"), "utf8").trim().split("\n");
  const strata = summaryLines.map((line) => (JSON.parse(line) as SecondTouchSummaryRow).stratum);
  assert.ok(strata.includes("control"));
  assert.ok(strata.includes("untouched"));
}

test("runSecondTouchScore_writes_a_summary_jsonl_beside_the_second_touch_raw_jsonl", async () => {
  const caseId = "second-touch-pipeline";
  const corpusDir = extendableCorpusDir(caseId);
  const sourceRunDir = tempDir("eval-second-touch-score-source-");
  writeRawJsonl(sourceRunDir, [sourceRow(caseId)]);
  const runDir = tempDir("eval-second-touch-score-run-");
  writeRawJsonl(runDir, [seededRow(caseId, { files: { "thing.ts": extendedSource() } }), controlRow(caseId, { files: { "thing.ts": identitySource() } })]);

  const result = await runSecondTouchScore({ runDir, sourceRunDir, corpusDir });

  assertSummaryHasBothStrata(result, runDir);
});
