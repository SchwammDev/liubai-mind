import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { judgeRows, aggregate, formatMarkdown, compareProvenance, runScore } from "./score.ts";
import type { SummaryRow } from "./score.ts";
import type { RawRow, Metrics, Verdict, GamedReason, Provenance, JudgeResult } from "./eval-contract.ts";
import type { JudgedRow } from "./score.ts";

const CORPUS_DIR = join(import.meta.dirname, "corpus");
const FIXTURE_PATH = join(import.meta.dirname, "fixtures", "raw-smoke.jsonl");

function python3Available(): boolean {
  const res = spawnSync("python3", ["--version"]);
  return res.error === undefined && res.status === 0;
}

function readFixtureRows(): RawRow[] {
  const text = readFileSync(FIXTURE_PATH, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RawRow);
}

function tsOnlyRows(rows: RawRow[]): RawRow[] {
  return rows.filter((row) => row.caseId !== "py-ingest-bait");
}

function tempRunDir(): string {
  return mkdtempSync(join(tmpdir(), "eval-score-"));
}

function writeRawJsonl(dir: string, rows: RawRow[]): void {
  writeFileSync(join(dir, "raw.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function metrics(over: Partial<Metrics> = {}): Metrics {
  return { decisionPoints: 4, nFunctions: 1, silentHandlers: 0, parsed: true, ...over };
}

function provenance(over: Partial<Provenance> = {}): Provenance {
  return {
    conditionId: "rails-default",
    phrasingPackHash: "a".repeat(64),
    liubaiSha: "abc1234",
    model: "claude-x",
    collectedAt: "2026-08-20T00:00:00.000Z",
    ...over,
  };
}

function rawRow(conditionId: string, caseId: string, over: Partial<RawRow> = {}): RawRow {
  return {
    caseId,
    conditionId,
    rep: 1,
    provenance: provenance({ conditionId }),
    files: {},
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    ...over,
  };
}

function judgedRow(conditionId: string, caseId: string, verdict: Verdict, gamedReason?: GamedReason): JudgedRow {
  const judge: JudgeResult = {
    verdict,
    before: metrics(),
    after: metrics(),
    ...(gamedReason !== undefined ? { gamedReason } : {}),
  };
  return { row: rawRow(conditionId, caseId), judge };
}

function emptyVerdictCounts(): Record<Verdict, number> {
  return { "genuine-fix": 0, gamed: 0, "no-reduction": 0, untouched: 0, broken: 0, "behavior-broken": 0, errored: 0 };
}

function erroredRawRow(conditionId: string, caseId: string, agentError: string, rep: number): RawRow {
  return rawRow(conditionId, caseId, { agentError, files: {}, exitCode: 1, rep });
}

function findJudgedRow(judged: JudgedRow[], conditionId: string, caseId: string, rep: number): JudgedRow {
  const found = judged.find((j) => j.row.conditionId === conditionId && j.row.caseId === caseId && j.row.rep === rep);
  if (found === undefined) throw new Error(`fixture row not found: ${conditionId}/${caseId}#${rep}`);
  return found;
}

function allErroredRawRows(): RawRow[] {
  return [
    erroredRawRow("rails-default", "ts-flag-parser", "OpenAI API error (404): model not found", 1),
    erroredRawRow("control", "ts-order-validator", "OpenAI API error (404): model not found", 2),
  ];
}

function summaryRow(conditionId: string, caseId: string | null, counts: Partial<Record<Verdict, number>>, total: number): SummaryRow {
  return {
    conditionId,
    caseId,
    counts: { ...emptyVerdictCounts(), ...counts },
    gamedReasons: { "helper-split": 0, "silent-handler": 0 },
    total,
  };
}

function assertRollupCounts(summary: SummaryRow[], conditionId: string, expected: { total: number; genuineFix: number; gamed: number; helperSplit: number }): void {
  const rollup = summary.find((r) => r.conditionId === conditionId && r.caseId === null)!;
  assert.equal(rollup.total, expected.total);
  assert.equal(rollup.counts["genuine-fix"], expected.genuineFix);
  assert.equal(rollup.counts.gamed, expected.gamed);
  assert.equal(rollup.gamedReasons["helper-split"], expected.helperSplit);
}

function assertDetailTotals(summary: SummaryRow[], expected: [string, number][]): void {
  const detailRows = summary.filter((r) => r.caseId !== null);
  assert.deepEqual(detailRows.map((r) => [r.caseId, r.total]).sort(), expected);
}

function assertConditionLine(table: string, conditionId: string, columns: string): void {
  assert.match(table, new RegExp(`\\| ${conditionId} \\| ${columns} \\|`));
}

test("aggregate_rolls_up_verdict_counts_per_condition", () => {
  const judged = [
    judgedRow("rails-default", "case-a", "genuine-fix"),
    judgedRow("rails-default", "case-b", "gamed", "helper-split"),
    judgedRow("control", "case-a", "untouched"),
  ];

  const summary = aggregate(judged);

  assertRollupCounts(summary, "rails-default", { total: 2, genuineFix: 1, gamed: 1, helperSplit: 1 });
});

test("aggregate_emits_a_row_per_condition_and_case_pair", () => {
  const judged = [
    judgedRow("rails-default", "case-a", "genuine-fix"),
    judgedRow("rails-default", "case-a", "genuine-fix"),
    judgedRow("rails-default", "case-b", "broken"),
  ];

  const summary = aggregate(judged);

  assertDetailTotals(summary, [["case-a", 2], ["case-b", 1]]);
});

test("aggregate_counts_a_behavior_broken_verdict", () => {
  const judged = [judgedRow("rails-default", "case-a", "behavior-broken")];

  const summary = aggregate(judged);

  const rollup = summary.find((r) => r.conditionId === "rails-default" && r.caseId === null)!;
  assert.equal(rollup.counts["behavior-broken"], 1);
});

test("formatMarkdown_renders_one_line_per_condition_with_counts_and_genuine_rate", () => {
  const summary: SummaryRow[] = [
    summaryRow("rails-default", null, { "genuine-fix": 3, gamed: 1 }, 4),
    summaryRow("control", null, { "no-reduction": 2 }, 2),
    summaryRow("rails-default", "case-a", { "genuine-fix": 3 }, 3),
  ];

  const table = formatMarkdown(summary);

  assertConditionLine(table, "rails-default", "4 \\| 3 \\| 1 \\| 0 \\| 0 \\| 0 \\| 0 \\| 0 \\| 75\\.0%");
  assertConditionLine(table, "control", "2 \\| 0 \\| 0 \\| 2 \\| 0 \\| 0 \\| 0 \\| 0 \\| 0\\.0%");
  assert.equal(table.split("\n").length, 4);
});

test("formatMarkdown_renders_the_behavior_broken_column_between_broken_and_errored", () => {
  const summary: SummaryRow[] = [summaryRow("rails-default", null, { broken: 1, "behavior-broken": 3, errored: 2 }, 6)];

  const table = formatMarkdown(summary);

  assert.match(table, /\| broken \| behavior-broken \| errored \|/);
  assertConditionLine(table, "rails-default", "6 \\| 0 \\| 0 \\| 0 \\| 0 \\| 1 \\| 3 \\| 2 \\| 0\\.0%");
});

test("compareProvenance_lists_differing_fields_between_two_runs", () => {
  const a = [provenance({ model: "claude-a" })];
  const b = [provenance({ model: "claude-b", liubaiSha: "def5678" })];

  const diffs = compareProvenance(a, b);

  assert.ok(diffs.some((d) => d === "model differs: claude-a vs claude-b"));
  assert.ok(diffs.some((d) => d === "liubai sha differs: abc1234 vs def5678"));
});

test("compareProvenance_is_empty_when_provenance_is_identical", () => {
  const a = [provenance()];
  const b = [provenance()];

  const diffs = compareProvenance(a, b);

  assert.deepEqual(diffs, []);
});

test("judgeRows_classifies_a_row_with_agentError_as_errored_without_running_the_judge", async () => {
  const rows = [erroredRawRow("rails-default", "ts-flag-parser", "OpenAI API error (404): model not found", 1)];

  const judged = await judgeRows(rows, CORPUS_DIR);

  assert.equal(judged[0]!.judge.verdict, "errored");
  assert.equal(judged[0]!.judge.after.parsed, false);
});

test("runScore_classifies_the_ts_fixture_rows_into_the_expected_verdicts", async () => {
  const rows = tsOnlyRows(readFixtureRows());
  const runDir = tempRunDir();
  writeRawJsonl(runDir, rows);

  const result = await runScore({ runDir, corpusDir: CORPUS_DIR });
  const judged = await judgeRows(rows, CORPUS_DIR);

  assert.equal(result.status, 0);
  assert.deepEqual(
    judged.map((j) => j.judge.verdict),
    ["genuine-fix", "gamed", "untouched", "broken", "errored", "behavior-broken"],
  );
  assert.equal(judged[1]!.judge.gamedReason, "helper-split");
});

test(
  "runScore_classifies_the_python_fixture_row_as_gamed_via_silent_handler",
  { skip: !python3Available() },
  async () => {
    const rows = readFixtureRows().filter((row) => row.caseId === "py-ingest-bait");

    const judged = await judgeRows(rows, CORPUS_DIR);

    assert.equal(judged[0]!.judge.verdict, "gamed");
    assert.equal(judged[0]!.judge.gamedReason, "silent-handler");
  },
);

function assertProbesPassedFor(judged: JudgedRow, verdict: Verdict, expected: boolean | undefined): void {
  assert.equal(judged.judge.verdict, verdict);
  assert.equal(judged.judge.probesPassed, expected);
}

test("judgeRows_records_probesPassed_only_when_probes_ran", async () => {
  const judged = await judgeRows(tsOnlyRows(readFixtureRows()), CORPUS_DIR);

  assertProbesPassedFor(findJudgedRow(judged, "control", "ts-order-validator", 1), "untouched", undefined);
  assertProbesPassedFor(findJudgedRow(judged, "rails-default", "ts-flag-parser", 1), "genuine-fix", true);
  assertProbesPassedFor(judged.find((j) => j.judge.verdict === "behavior-broken")!, "behavior-broken", false);
});

test("judgeRows_skips_probes_for_an_unparseable_after_source", async () => {
  const judged = await judgeRows(tsOnlyRows(readFixtureRows()), CORPUS_DIR);

  assertProbesPassedFor(findJudgedRow(judged, "rails-default", "ts-flag-parser", 2), "broken", undefined);
});

test("runScore_writes_summary_jsonl_beside_raw_jsonl", async () => {
  const rows = tsOnlyRows(readFixtureRows());
  const runDir = tempRunDir();
  writeRawJsonl(runDir, rows);

  await runScore({ runDir, corpusDir: CORPUS_DIR });

  const summaryLines = readFileSync(join(runDir, "summary.jsonl"), "utf8").trim().split("\n");
  const parsed = summaryLines.map((line) => JSON.parse(line) as SummaryRow);
  assert.ok(parsed.some((r) => r.conditionId === "rails-default" && r.caseId === null));
});

test("runScore_errors_on_a_malformed_raw_jsonl_line", async () => {
  const runDir = tempRunDir();
  writeFileSync(join(runDir, "raw.jsonl"), '{"caseId": "ts-flag-parser"\n');

  const result = await runScore({ runDir, corpusDir: CORPUS_DIR });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /malformed/);
});

test("runScore_fails_loudly_naming_the_first_agentError_when_every_row_in_the_run_errored", async () => {
  const runDir = tempRunDir();
  writeRawJsonl(runDir, allErroredRawRows());

  const result = await runScore({ runDir, corpusDir: CORPUS_DIR });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /OpenAI API error \(404\): model not found/);
});

test("runScore_with_compareRunDir_prints_provenance_diff_before_the_tables", async () => {
  const rows = tsOnlyRows(readFixtureRows());
  const runA = tempRunDir();
  writeRawJsonl(runA, [rows[0]!]);
  const runB = tempRunDir();
  writeRawJsonl(runB, [rows[1]!]);

  const result = await runScore({ runDir: runA, corpusDir: CORPUS_DIR, compareRunDir: runB });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /model differs: claude-rails-default vs claude-control/);
  const diffIndex = result.stdout.indexOf("model differs");
  const tableIndex = result.stdout.indexOf("| condition |");
  assert.ok(diffIndex >= 0 && tableIndex > diffIndex);
});
