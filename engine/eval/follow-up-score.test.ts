import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  judgeFollowUpRows,
  aggregateFollowUp,
  formatFollowUpMarkdown,
  touchKindOf,
  routeScore,
  runFollowUpScore,
  followUpRecordFor,
} from "./follow-up-score.ts";
import type { JudgedFollowUpRow, FollowUpSummaryRow, FollowUpVerdict } from "./follow-up-score.ts";
import type { RawRow, Provenance, FollowUpInfo, Metrics } from "./eval-contract.ts";
import type { RepetitionRecord } from "./repetition-record.ts";
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
  const corpusDir = tempDir("eval-follow-up-score-corpus-");
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
  writeFileSync(join(caseDir, "behavior-checks.json"), JSON.stringify([{ args: [1], returns: 1 }]));
  writeFileSync(
    join(caseDir, "extension.json"),
    JSON.stringify({
      task: "Add an optional double parameter that doubles the result when true.",
      behaviorChecks: [{ args: [2, true], returns: 4 }],
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
  const corpusDir = tempDir("eval-follow-up-score-corpus-");
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
  writeFileSync(join(caseDir, "behavior-checks.json"), JSON.stringify([{ args: [1], returns: { value: 1 } }]));
  writeFileSync(
    join(caseDir, "extension.json"),
    JSON.stringify({
      task: "Add an optional double parameter that doubles the result when true.",
      behaviorChecks: [{ args: [2, true], returns: { value: 4 } }],
    }),
  );
  writeFileSync(join(caseDir, "thing.ts.case"), identityObjectSource());
  return corpusDir;
}

function noExtensionCorpusDir(caseId: string): string {
  const corpusDir = tempDir("eval-follow-up-score-corpus-");
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
  writeFileSync(join(caseDir, "behavior-checks.json"), JSON.stringify([{ args: [1], returns: 1 }]));
  writeFileSync(join(caseDir, "thing.ts.case"), identitySource());
  return corpusDir;
}

function provenance(over: Partial<Provenance> = {}): Provenance {
  return {
    treatmentId: "rails-default",
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
    treatmentId: "rails-default",
    repetition: 1,
    provenance: provenance(),
    files: { "thing.ts": identitySource() },
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    ...over,
  };
}

function followUpInfo(over: Partial<FollowUpInfo> = {}): FollowUpInfo {
  return { sourceRun: "source-run", sourceRepetition: 1, control: false, ...over };
}

function earlierResultRow(caseId: string, over: Partial<RawRow> = {}, infoOver: Partial<FollowUpInfo> = {}): RawRow {
  return {
    caseId,
    treatmentId: "rails-default",
    repetition: 1,
    provenance: provenance(),
    files: { "thing.ts": extendedSource() },
    exitCode: 0,
    timedOut: false,
    durationMs: 500,
    followUp: followUpInfo(infoOver),
    ...over,
  };
}

function controlRow(caseId: string, over: Partial<RawRow> = {}): RawRow {
  return earlierResultRow(caseId, over, { sourceRepetition: null, control: true });
}

async function judgeOne(corpusDir: string, row: RawRow, sourceRows: RawRow[] = []): Promise<JudgedFollowUpRow> {
  const judged = await judgeFollowUpRows([row], sourceRows, corpusDir);
  return judged[0]!;
}

test("judgeFollowUpRows_classifies_an_agent_errored_row_as_errored_before_any_other_check", async () => {
  const caseId = "follow-up-errored";
  const corpusDir = extendableCorpusDir(caseId);
  const row = earlierResultRow(caseId, { agentError: "boom", files: { "thing.ts": GARBAGE_SOURCE } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "errored");
});

test("judgeFollowUpRows_classifies_a_timed_out_row_as_timed_out_before_checking_the_entry_file", async () => {
  const caseId = "follow-up-timed-out";
  const corpusDir = extendableCorpusDir(caseId);
  const row = earlierResultRow(caseId, { timedOut: true, files: {} });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "timed-out");
});

test("judgeFollowUpRows_prefers_timed_out_over_errored_when_both_apply", async () => {
  const caseId = "follow-up-timed-out-and-errored";
  const corpusDir = extendableCorpusDir(caseId);
  const row = earlierResultRow(caseId, { timedOut: true, agentError: "boom", files: { "thing.ts": GARBAGE_SOURCE } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "timed-out");
});

test("judgeFollowUpRows_classifies_a_missing_entry_file_as_broken", async () => {
  const caseId = "follow-up-missing-entry";
  const corpusDir = extendableCorpusDir(caseId);
  const row = earlierResultRow(caseId, { files: {} });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "broken");
});

test("judgeFollowUpRows_classifies_an_unparseable_entry_file_as_broken", async () => {
  const caseId = "follow-up-unparseable";
  const corpusDir = extendableCorpusDir(caseId);
  const row = earlierResultRow(caseId, { files: { "thing.ts": GARBAGE_SOURCE } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "broken");
});

test("judgeFollowUpRows_classifies_an_earlierResult_row_identical_to_the_source_files_as_untouched", async () => {
  const caseId = "follow-up-untouched-earlier-result";
  const corpusDir = extendableCorpusDir(caseId);
  const source = sourceRow(caseId, { files: { "thing.ts": touchedButUnextendedSource() } });
  const row = earlierResultRow(caseId, { files: { "thing.ts": touchedButUnextendedSource() } });

  const judged = await judgeOne(corpusDir, row, [source]);

  assert.equal(judged.judge.verdict, "untouched");
});

test("judgeFollowUpRows_classifies_a_control_row_identical_to_the_pristine_case_files_as_untouched", async () => {
  const caseId = "follow-up-untouched-control";
  const corpusDir = extendableCorpusDir(caseId);
  const row = controlRow(caseId, { files: { "thing.ts": identitySource() } });

  const judged = await judgeOne(corpusDir, row, []);

  assert.equal(judged.judge.verdict, "untouched");
});

test("judgeFollowUpRows_classifies_a_touched_row_that_fails_the_original_behaviorChecks_as_regressed", async () => {
  const caseId = "follow-up-regressed";
  const corpusDir = extendableCorpusDir(caseId);
  const row = earlierResultRow(caseId, { files: { "thing.ts": regressedSource() } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "regressed");
});

test("judgeFollowUpRows_prefers_regressed_over_extension_failed_when_both_behaviorCheck_sets_fail", async () => {
  const caseId = "follow-up-precedence";
  const corpusDir = extendableCorpusDir(caseId);
  const row = earlierResultRow(caseId, { files: { "thing.ts": regressedSource() } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "regressed");
});

test("judgeFollowUpRows_prefers_errored_over_broken_when_both_apply", async () => {
  const caseId = "follow-up-errored-and-broken";
  const corpusDir = extendableCorpusDir(caseId);
  const row = earlierResultRow(caseId, { agentError: "boom", files: { "thing.ts": GARBAGE_SOURCE } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "errored");
});

test("judgeFollowUpRows_classifies_original_behaviorChecks_green_and_extension_behaviorChecks_red_as_extension_failed", async () => {
  const caseId = "follow-up-extension-failed";
  const corpusDir = extendableCorpusDir(caseId);
  const row = earlierResultRow(caseId, { files: { "thing.ts": touchedButUnextendedSource() } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId, { files: { "thing.ts": identitySource() } })]);

  assert.equal(judged.judge.verdict, "extension-failed");
});

test("judgeFollowUpRows_classifies_both_behaviorCheck_sets_green_as_extended", async () => {
  const caseId = "follow-up-extended";
  const corpusDir = extendableCorpusDir(caseId);
  const row = earlierResultRow(caseId, { files: { "thing.ts": extendedSource() } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId)]);

  assert.equal(judged.judge.verdict, "extended");
});

test("judgeFollowUpRows_classifies_a_solution_that_widens_the_returned_shape_as_extended_not_regressed", async () => {
  const caseId = "follow-up-shape-widening";
  const corpusDir = extendableObjectCorpusDir(caseId);
  const row = earlierResultRow(caseId, { files: { "thing.ts": shapeWideningObjectSource() } });

  const judged = await judgeOne(corpusDir, row, [sourceRow(caseId, { files: { "thing.ts": identityObjectSource() } })]);

  assert.equal(judged.judge.verdict, "extended");
});

test("judgeFollowUpRows_throws_when_the_row_case_has_no_extension_spec", async () => {
  const caseId = "follow-up-no-extension";
  const corpusDir = noExtensionCorpusDir(caseId);
  const row = earlierResultRow(caseId, { files: { "thing.ts": extendedSource() } });

  await assert.rejects(() => judgeFollowUpRows([row], [sourceRow(caseId)], corpusDir), /extension/);
});

test("judgeFollowUpRows_stratifies_an_earlierResult_row_by_its_source_rows_single_task_verdict", async () => {
  const caseId = "follow-up-stratify-bar-missed";
  const corpusDir = extendableCorpusDir(caseId);
  const source = sourceRow(caseId, { files: { "thing.ts": touchedButUnextendedSource() } });
  const row = earlierResultRow(caseId, { files: { "thing.ts": extendedSource() } });

  const judged = await judgeOne(corpusDir, row, [source]);

  assert.equal(judged.stratum, "bar-missed");
});

test("judgeFollowUpRows_stratifies_an_untouched_source_row_as_the_untouched_single_task_verdict", async () => {
  const caseId = "follow-up-stratify-untouched";
  const corpusDir = extendableCorpusDir(caseId);
  const source = sourceRow(caseId, { files: { "thing.ts": identitySource() } });
  const row = earlierResultRow(caseId, { files: { "thing.ts": extendedSource() } });

  const judged = await judgeOne(corpusDir, row, [source]);

  assert.equal(judged.stratum, "untouched");
});

test("judgeFollowUpRows_stratifies_every_control_row_into_the_control_stratum", async () => {
  const caseId = "follow-up-stratify-control";
  const corpusDir = extendableCorpusDir(caseId);
  const row = controlRow(caseId, { files: { "thing.ts": extendedSource() } });

  const judged = await judgeOne(corpusDir, row, []);

  assert.equal(judged.stratum, "control");
});

function emptyMetrics(): Metrics {
  return { decisionPoints: 0, nFunctions: 0, silentHandlers: 0, parsed: true };
}

function judgedFollowUpRow(
  treatmentId: string,
  caseId: string,
  verdict: FollowUpVerdict,
  stratum: string,
  over: Partial<RawRow> = {},
  diffCounts: { linesAdded: number; linesRemoved: number } = { linesAdded: 0, linesRemoved: 0 },
): JudgedFollowUpRow {
  return {
    row: earlierResultRow(caseId, { treatmentId, ...over }),
    judge: { verdict, ...diffCounts, before: emptyMetrics(), after: emptyMetrics(), createdFiles: [], failedBehaviorChecks: [] },
    stratum,
    contaminated: false,
    consultedRail: false,
    entryUnchanged: false,
    entrySymbolComplexityBefore: null,
    entrySymbolComplexityAfter: null,
  };
}

function rollupOf(summary: FollowUpSummaryRow[], treatmentId: string): FollowUpSummaryRow {
  return summary.find((r) => r.treatmentId === treatmentId && r.caseId === null && r.stratum === null)!;
}

function stratumRowOf(summary: FollowUpSummaryRow[], treatmentId: string, stratum: string): FollowUpSummaryRow {
  return summary.find((r) => r.treatmentId === treatmentId && r.caseId === null && r.stratum === stratum)!;
}

function caseRowOf(summary: FollowUpSummaryRow[], treatmentId: string, caseId: string): FollowUpSummaryRow {
  return summary.find((r) => r.treatmentId === treatmentId && r.caseId === caseId)!;
}

function assertRollupCounts(summary: FollowUpSummaryRow[], treatmentId: string, expected: { total: number; extended: number; regressed: number }): void {
  const rollup = rollupOf(summary, treatmentId);
  assert.equal(rollup.total, expected.total);
  assert.equal(rollup.counts.extended, expected.extended);
  assert.equal(rollup.counts.regressed, expected.regressed);
}

test("aggregateFollowUp_rolls_up_verdict_counts_per_treatment_across_every_stratum", () => {
  const judged = [
    judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedFollowUpRow("rails-default", "case-b", "regressed", "gamed"),
    judgedFollowUpRow("control", "case-a", "untouched", "control"),
  ];

  const summary = aggregateFollowUp(judged);

  assertRollupCounts(summary, "rails-default", { total: 2, extended: 1, regressed: 1 });
});

function assertStratumTotals(summary: FollowUpSummaryRow[], treatmentId: string, expected: Record<string, number>): void {
  const totals = Object.fromEntries(Object.keys(expected).map((stratum) => [stratum, stratumRowOf(summary, treatmentId, stratum).total]));
  assert.deepEqual(totals, expected);
}

test("aggregateFollowUp_emits_a_row_per_treatment_and_source_verdict_stratum", () => {
  const judged = [
    judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedFollowUpRow("rails-default", "case-b", "regressed", "gamed"),
    judgedFollowUpRow("rails-default", "case-c", "untouched", "control"),
  ];

  const summary = aggregateFollowUp(judged);

  assertStratumTotals(summary, "rails-default", { "genuine-fix": 1, gamed: 1, control: 1 });
});

test("aggregateFollowUp_keeps_the_control_stratum_separate_from_earlierResult_strata", () => {
  const judged = [
    judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedFollowUpRow("rails-default", "case-a", "untouched", "control"),
  ];

  const summary = aggregateFollowUp(judged);

  assert.equal(stratumRowOf(summary, "rails-default", "control").counts.untouched, 1);
  assert.equal(stratumRowOf(summary, "rails-default", "genuine-fix").counts.extended, 1);
});

function assertCaseDetailCounts(summary: FollowUpSummaryRow[], treatmentId: string, caseId: string, expected: { total: number; extended: number; regressed: number }): void {
  const detail = caseRowOf(summary, treatmentId, caseId);
  assert.equal(detail.total, expected.total);
  assert.equal(detail.counts.extended, expected.extended);
  assert.equal(detail.counts.regressed, expected.regressed);
}

test("aggregateFollowUp_emits_a_case_detail_row_aggregated_across_strata", () => {
  const judged = [
    judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedFollowUpRow("rails-default", "case-a", "regressed", "control"),
  ];

  const summary = aggregateFollowUp(judged);

  assertCaseDetailCounts(summary, "rails-default", "case-a", { total: 2, extended: 1, regressed: 1 });
});

test("aggregateFollowUp_computes_extension_success_rate_over_non_errored_rows", () => {
  const judged = [
    judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedFollowUpRow("rails-default", "case-b", "regressed", "genuine-fix"),
    judgedFollowUpRow("rails-default", "case-c", "errored", "genuine-fix"),
  ];

  const summary = aggregateFollowUp(judged);

  assert.equal(rollupOf(summary, "rails-default").extensionSuccessRate, 50);
});

test("aggregateFollowUp_excludes_timed_out_rows_from_the_extension_success_rate_denominator", () => {
  const judged = [
    judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedFollowUpRow("rails-default", "case-b", "timed-out", "genuine-fix"),
  ];

  const summary = aggregateFollowUp(judged);

  assert.equal(rollupOf(summary, "rails-default").extensionSuccessRate, 100);
});

test("aggregateFollowUp_reports_null_extension_success_rate_when_every_row_errored", () => {
  const judged = [judgedFollowUpRow("rails-default", "case-a", "errored", "genuine-fix")];

  const summary = aggregateFollowUp(judged);

  assert.equal(rollupOf(summary, "rails-default").extensionSuccessRate, null);
});

test("aggregateFollowUp_means_lines_added_and_lines_removed_across_the_bucket", () => {
  const judged = [
    judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix", {}, { linesAdded: 4, linesRemoved: 2 }),
    judgedFollowUpRow("rails-default", "case-b", "extended", "genuine-fix", {}, { linesAdded: 8, linesRemoved: 6 }),
  ];

  const summary = aggregateFollowUp(judged);

  const rollup = rollupOf(summary, "rails-default");
  assert.equal(rollup.meanLinesAdded, 6);
  assert.equal(rollup.meanLinesRemoved, 4);
});

function nudges(over: Partial<Record<RuleName, number>> = {}): Record<RuleName, number> {
  const base = Object.fromEntries(Object.values(RULE).map((rule) => [rule, 0])) as Record<RuleName, number>;
  return { ...base, ...over };
}

function assertCostSummary(summary: FollowUpSummaryRow[], treatmentId: string, expected: { meanTurns: number | null; meanNudgesTotal: number | null; costAvailable: number }): void {
  const rollup = rollupOf(summary, treatmentId);
  assert.equal(rollup.meanTurns, expected.meanTurns);
  assert.equal(rollup.meanNudgesTotal, expected.meanNudgesTotal);
  assert.equal(rollup.costAvailable, expected.costAvailable);
}

test("aggregateFollowUp_means_turns_and_total_rail_nudges_only_over_rows_that_report_them", () => {
  const judged = [
    judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix", { turns: 4, nudges: nudges({ cc: 2, "discourage-comments": 1 }) }),
    judgedFollowUpRow("rails-default", "case-b", "extended", "genuine-fix", {}),
  ];

  const summary = aggregateFollowUp(judged);

  assertCostSummary(summary, "rails-default", { meanTurns: 4, meanNudgesTotal: 3, costAvailable: 1 });
});

test("aggregateFollowUp_reports_null_not_zero_for_cost_fields_when_no_row_in_the_bucket_reports_them", () => {
  const judged = [judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix", {})];

  const summary = aggregateFollowUp(judged);

  assertCostSummary(summary, "rails-default", { meanTurns: null, meanNudgesTotal: null, costAvailable: 0 });
});

test("aggregateFollowUp_stamps_every_row_as_follow_up", () => {
  const judged = [judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix")];

  const summary = aggregateFollowUp(judged);

  assert.ok(summary.every((row) => row.touch === "follow-up"));
});

test("formatFollowUpMarkdown_renders_a_dash_for_null_cost_fields_never_a_zero", () => {
  const judged = [judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix")];
  const summary = aggregateFollowUp(judged);

  const table = formatFollowUpMarkdown(summary);

  assert.match(table, /\| rails-default \| 1 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 100\.0% \| 0\.0 \| 0\.0 \| - \| - \|/);
});

test("formatFollowUpMarkdown_names_timed_out_as_its_own_column", () => {
  const judged = [
    judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix"),
    judgedFollowUpRow("rails-default", "case-b", "timed-out", "genuine-fix"),
  ];
  const summary = aggregateFollowUp(judged);

  const table = formatFollowUpMarkdown(summary);

  assert.match(table, /\| timed-out \|/);
  assert.match(table, /\| rails-default \| 2 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \| 1 \| 100\.0% \|/);
});

test("formatFollowUpMarkdown_includes_stratum_rollups_suffixed_with_the_stratum_name", () => {
  const judged = [judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix")];
  const summary = aggregateFollowUp(judged);

  const table = formatFollowUpMarkdown(summary);

  assert.match(table, /\| rails-default \[genuine-fix\] \|/);
});

test("formatFollowUpMarkdown_excludes_per_case_detail_rows", () => {
  const judged = [judgedFollowUpRow("rails-default", "case-a", "extended", "genuine-fix")];
  const summary = aggregateFollowUp(judged);

  const table = formatFollowUpMarkdown(summary);

  assert.equal(table.split("\n").length, 4);
});

function writeRawJsonl(dir: string, rows: RawRow[]): void {
  writeFileSync(join(dir, "raw.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

test("touchKindOf_reports_single_task_when_no_row_carries_followUp", () => {
  const kind = touchKindOf([sourceRow("case-a")]);

  assert.deepEqual(kind, { kind: "single-task" });
});

test("touchKindOf_reports_follow_up_and_the_shared_source_run_when_every_row_carries_followUp", () => {
  const kind = touchKindOf([earlierResultRow("case-a"), controlRow("case-a")]);

  assert.deepEqual(kind, { kind: "follow-up", sourceRun: "source-run" });
});

test("touchKindOf_errors_when_a_run_mixes_single_task_and_follow_up_rows", () => {
  const kind = touchKindOf([sourceRow("case-a"), earlierResultRow("case-a")]);

  assert.ok("error" in kind);
});

test("touchKindOf_errors_when_follow_up_rows_reference_more_than_one_source_run", () => {
  const kind = touchKindOf([earlierResultRow("case-a", {}, { sourceRun: "run-x" }), earlierResultRow("case-a", {}, { sourceRun: "run-y" })]);

  assert.ok("error" in kind);
});

function writeSourceRun(runsRoot: string, name: string, rows: RawRow[]): void {
  const dir = join(runsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeRawJsonl(dir, rows);
}

function assertScoredAsSingleTask(result: { status: number; stdout: string }, runDir: string): void {
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\| treatment \|/);
  assert.ok(existsSync(join(runDir, "summary.jsonl")));
}

test("routeScore_routes_a_single_task_run_to_runScore_unchanged", async () => {
  const runsRoot = tempDir("eval-score-router-runs-");
  const runDir = join(runsRoot, "target");
  mkdirSync(runDir, { recursive: true });
  const corpusDir = extendableCorpusDir("follow-up-router-case");
  writeRawJsonl(runDir, [sourceRow("follow-up-router-case", { files: { "thing.ts": extendedSource() } })]);

  const result = await routeScore({ runDir, corpusDir, repoRoot: join(import.meta.dirname, "..", "..") }, runsRoot);

  assertScoredAsSingleTask(result, runDir);
});

test("routeScore_routes_a_follow_up_run_to_follow_up_scoring", async () => {
  const runsRoot = tempDir("eval-score-router-runs-");
  const caseId = "follow-up-router-second";
  const corpusDir = extendableCorpusDir(caseId);
  writeSourceRun(runsRoot, "source-run", [sourceRow(caseId)]);
  const runDir = join(runsRoot, "target");
  mkdirSync(runDir, { recursive: true });
  writeRawJsonl(runDir, [earlierResultRow(caseId, { files: { "thing.ts": extendedSource() } })]);

  const result = await routeScore({ runDir, corpusDir, repoRoot: join(import.meta.dirname, "..", "..") }, runsRoot);

  const summary = readFileSync(join(runDir, "summary.jsonl"), "utf8");
  assert.equal(result.status, 0);
  assert.ok(summary.includes('"touch":"follow-up"'));
});

test("routeScore_fails_a_run_that_mixes_single_task_and_follow_up_rows", async () => {
  const runsRoot = tempDir("eval-score-router-runs-");
  const caseId = "follow-up-router-mixed";
  const corpusDir = extendableCorpusDir(caseId);
  const runDir = join(runsRoot, "target");
  mkdirSync(runDir, { recursive: true });
  writeRawJsonl(runDir, [sourceRow(caseId), earlierResultRow(caseId)]);

  const result = await routeScore({ runDir, corpusDir, repoRoot: join(import.meta.dirname, "..", "..") }, runsRoot);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /mixes single-task and follow-up/);
});

function assertSummaryHasBothStrata(result: { status: number }, runDir: string): void {
  assert.equal(result.status, 0);
  const summaryLines = readFileSync(join(runDir, "summary.jsonl"), "utf8").trim().split("\n");
  const strata = summaryLines.map((line) => (JSON.parse(line) as FollowUpSummaryRow).stratum);
  assert.ok(strata.includes("control"));
  assert.ok(strata.includes("untouched"));
}

test("runFollowUpScore_writes_a_summary_jsonl_beside_the_follow_up_raw_jsonl", async () => {
  const caseId = "follow-up-pipeline";
  const corpusDir = extendableCorpusDir(caseId);
  const sourceRunDir = tempDir("eval-follow-up-score-source-");
  writeRawJsonl(sourceRunDir, [sourceRow(caseId)]);
  const runDir = tempDir("eval-follow-up-score-run-");
  writeRawJsonl(runDir, [earlierResultRow(caseId, { files: { "thing.ts": extendedSource() } }), controlRow(caseId, { files: { "thing.ts": identitySource() } })]);

  const result = await runFollowUpScore({ runDir, sourceRunDir, corpusDir });

  assertSummaryHasBothStrata(result, runDir);
});

function warnsAboutMissingSessionLogs(result: { stdout: string }): boolean {
  return /session\(s\) have no session log/.test(result.stdout);
}

test("runFollowUpScore_warns_in_its_output_when_a_row_has_no_session_log", async () => {
  const caseId = "follow-up-missing-session-log-warning";
  const corpusDir = extendableCorpusDir(caseId);
  const sourceRunDir = tempDir("eval-follow-up-score-source-");
  writeRawJsonl(sourceRunDir, [sourceRow(caseId)]);
  const runDir = tempDir("eval-follow-up-score-run-");
  writeRawJsonl(runDir, [earlierResultRow(caseId, { files: { "thing.ts": extendedSource() } })]);

  const result = await runFollowUpScore({ runDir, sourceRunDir, corpusDir });

  assert.ok(warnsAboutMissingSessionLogs(result));
});

async function followUpRecordOf(corpusDir: string, row: RawRow, sourceRows: RawRow[] = []): Promise<RepetitionRecord> {
  const [judged] = await judgeFollowUpRows([row], sourceRows, corpusDir);
  return followUpRecordFor(tempDir("eval-follow-up-record-"), judged!);
}

function startsFromOf(record: RepetitionRecord): unknown {
  return record.startsFrom;
}

function beforeMetricsOf(record: RepetitionRecord): unknown {
  return { decisionPointsBefore: record.decisionPointsBefore, entrySymbolComplexityBefore: record.entrySymbolComplexityBefore };
}

function logDerivedFactsOf(record: RepetitionRecord): unknown {
  return { transcriptPath: record.transcriptPath, retries: record.retries, nudges: record.nudges, toolCalls: record.toolCalls, firstEditTurn: record.firstEditTurn };
}

function verdictAndGamedReasonOf(record: RepetitionRecord): unknown {
  return { verdict: record.verdict, gamedReason: record.gamedReason };
}

test("followUpRecordFor_names_a_control_records_startsFrom_as_the_original_source", async () => {
  const caseId = "follow-up-record-control-starts-from";
  const corpusDir = extendableCorpusDir(caseId);
  const row = controlRow(caseId, { files: { "thing.ts": extendedSource() } });

  const record = await followUpRecordOf(corpusDir, row);

  assert.deepEqual(startsFromOf(record), { kind: "original-source" });
});

test("followUpRecordFor_names_the_earlier_run_and_repetition_an_earlierResult_record_started_from", async () => {
  const caseId = "follow-up-record-earlier-starts-from";
  const corpusDir = extendableCorpusDir(caseId);
  const source = sourceRow(caseId, { repetition: 3 });
  const row = earlierResultRow(caseId, { files: { "thing.ts": extendedSource() } }, { sourceRun: "earlier-run", sourceRepetition: 3 });

  const record = await followUpRecordOf(corpusDir, row, [source]);

  assert.deepEqual(startsFromOf(record), { kind: "earlier-result", sourceRun: "earlier-run", sourceRepetition: 3 });
});

test("followUpRecordFor_computes_before_metrics_from_the_earlier_files_not_the_pristine_source", async () => {
  const caseId = "follow-up-record-before-metrics";
  const corpusDir = extendableCorpusDir(caseId);
  const source = sourceRow(caseId, { files: { "thing.ts": extendedSource() } });
  const row = earlierResultRow(caseId, { files: { "thing.ts": `${extendedSource()}// noop\n` } });

  const record = await followUpRecordOf(corpusDir, row, [source]);

  assert.deepEqual(beforeMetricsOf(record), { decisionPointsBefore: 1, entrySymbolComplexityBefore: 2 });
});

test("followUpRecordFor_leaves_log_derived_facts_null_when_the_session_log_is_missing", async () => {
  const caseId = "follow-up-record-missing-log";
  const corpusDir = extendableCorpusDir(caseId);
  const row = controlRow(caseId, { files: { "thing.ts": extendedSource() } });

  const record = await followUpRecordOf(corpusDir, row);

  assert.deepEqual(logDerivedFactsOf(record), { transcriptPath: null, retries: null, nudges: null, toolCalls: null, firstEditTurn: null });
});

test("followUpRecordFor_names_the_verdict_and_never_a_gaming_reason", async () => {
  const caseId = "follow-up-record-verdict-reuse";
  const corpusDir = extendableCorpusDir(caseId);
  const source = sourceRow(caseId);
  const row = earlierResultRow(caseId, { files: { "thing.ts": extendedSource() } });

  const record = await followUpRecordOf(corpusDir, row, [source]);

  assert.deepEqual(verdictAndGamedReasonOf(record), { verdict: "extended", gamedReason: null });
});
