import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isSimulatedSessionRun,
  repFired,
  finalEntryIsCorrected,
  summarizeSimulatedSession,
  runSimulatedSessionScore,
} from "./simulated-session-score.ts";
import type { SimulatedSessionSummaryRow } from "./simulated-session-score.ts";
import { priorDraftPath } from "./simulated-session.ts";
import type { CaseManifest, RawRow, Provenance } from "./eval-contract.ts";
import type { RuleName } from "../contract.ts";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fixtureCase(): CaseManifest {
  return {
    id: "fixture-simulated-session-case",
    lang: "typescript",
    files: ["thing.ts.case"],
    entry: "thing.ts",
    entrySymbol: "f",
    task: "Improve thing.ts. Keep the public function signature and behavior unchanged.",
    baseline: { decisionPoints: 2, functions: 1, silentHandlers: 0 },
    tier: "easy",
    probes: [
      { args: [1], returns: 1 },
      { args: [-1], returns: -1 },
    ],
    extension: { task: "Handle a zero input by returning zero.", probes: [{ args: [0], returns: 0 }] },
  };
}

function draftSource(): string {
  return [
    "export function f(x: number): number {",
    "  if (x > 0) {",
    "    return 1;",
    "  }",
    "  if (x < 0) {",
    "    return -1;",
    "  }",
    "  return 0;",
    "}",
    "",
  ].join("\n");
}

function correctedSource(): string {
  return ["export function f(x: number): number {", "  return x === 0 ? 0 : Math.sign(x);", "}", ""].join("\n");
}

function extensionFailingSource(): string {
  return ["export function f(x: number): number {", "  return x > 0 ? 1 : -1;", "}", ""].join("\n");
}

function caseProbeFailingSource(): string {
  return ["export function f(x: number): number {", "  return -x;", "}", ""].join("\n");
}

function tempCorpusWithDraft(kase: CaseManifest, draft: string): string {
  const corpusDir = tempDir("eval-simulated-session-score-corpus-");
  mkdirSync(join(corpusDir, kase.id), { recursive: true });
  writeFileSync(priorDraftPath(corpusDir, kase), draft);
  return corpusDir;
}

function firingsOf(counts: Partial<Record<RuleName, number>>): Record<RuleName, number> {
  return counts as Record<RuleName, number>;
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

function simulatedSessionRow(caseId: string, over: Partial<RawRow> = {}): RawRow {
  const conditionId = over.conditionId ?? "rails-default";
  return {
    caseId,
    conditionId,
    rep: 1,
    provenance: provenance({ conditionId }),
    files: { "thing.ts": draftSource() },
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    simulatedSession: true,
    ...over,
  };
}

test("repFired_is_false_when_the_ccdelta_rule_never_recorded_a_firing", () => {
  const row = simulatedSessionRow("fixture-simulated-session-case");

  assert.equal(repFired(row), false);
});

test("repFired_is_true_when_the_live_rail_recorded_a_ccdelta_firing", () => {
  const row = simulatedSessionRow("fixture-simulated-session-case", { railFirings: firingsOf({ "cc-delta": 1 }) });

  assert.equal(repFired(row), true);
});

test("repFired_is_true_when_only_the_shadow_rail_recorded_a_ccdelta_firing", () => {
  const row = simulatedSessionRow("fixture-simulated-session-case", { shadowFirings: firingsOf({ "cc-delta": 1 }) });

  assert.equal(repFired(row), true);
});

test("repFired_ignores_firings_of_other_rules", () => {
  const row = simulatedSessionRow("fixture-simulated-session-case", { railFirings: firingsOf({ cc: 3 }) });

  assert.equal(repFired(row), false);
});

test("finalEntryIsCorrected_is_true_when_the_final_file_has_fewer_decision_points_than_the_draft_and_every_probe_passes", () => {
  const kase = fixtureCase();

  const corrected = finalEntryIsCorrected(kase, correctedSource(), { "thing.ts": correctedSource() }, 1, 2);

  assert.equal(corrected, true);
});

test("finalEntryIsCorrected_withholds_correction_when_the_final_file_does_not_drop_below_the_drafts_decision_points", () => {
  const kase = fixtureCase();

  const corrected = finalEntryIsCorrected(kase, draftSource(), { "thing.ts": draftSource() }, 2, 2);

  assert.equal(corrected, false);
});

test("finalEntryIsCorrected_withholds_correction_when_the_cases_own_probes_fail_despite_fewer_decision_points", () => {
  const kase = fixtureCase();

  const corrected = finalEntryIsCorrected(kase, caseProbeFailingSource(), { "thing.ts": caseProbeFailingSource() }, 0, 2);

  assert.equal(corrected, false);
});

test("finalEntryIsCorrected_withholds_correction_when_the_extension_probe_fails_even_though_the_cases_own_probes_pass", () => {
  const kase = fixtureCase();

  const corrected = finalEntryIsCorrected(kase, extensionFailingSource(), { "thing.ts": extensionFailingSource() }, 1, 2);

  assert.equal(corrected, false);
});

function assertFiredAndCorrectedCounts(row: SimulatedSessionSummaryRow, expected: { total: number; fired: number; corrected: number }): void {
  assert.deepEqual({ total: row.total, fired: row.fired, corrected: row.corrected }, expected);
}

test("summarizeSimulatedSession_excludes_unfired_reps_from_the_fired_and_corrected_denominator", async () => {
  const kase = fixtureCase();
  const corpusDir = tempCorpusWithDraft(kase, draftSource());
  const firedAndCorrected = simulatedSessionRow(kase.id, {
    rep: 1,
    railFirings: firingsOf({ "cc-delta": 1 }),
    files: { "thing.ts": correctedSource() },
  });
  const firedAndUncorrected = simulatedSessionRow(kase.id, {
    rep: 2,
    railFirings: firingsOf({ "cc-delta": 1 }),
    files: { "thing.ts": draftSource() },
  });
  const unfired = simulatedSessionRow(kase.id, { rep: 3, files: { "thing.ts": correctedSource() } });

  const summary = await summarizeSimulatedSession([firedAndCorrected, firedAndUncorrected, unfired], [kase], corpusDir);

  const row = summary.find((r) => r.conditionId === "rails-default")!;
  assertFiredAndCorrectedCounts(row, { total: 3, fired: 2, corrected: 1 });
});

test("summarizeSimulatedSession_computes_meanFinalDp_as_the_mean_final_entry_file_decision_points_over_fired_reps_only", async () => {
  const kase = fixtureCase();
  const corpusDir = tempCorpusWithDraft(kase, draftSource());
  const firedDpOne = simulatedSessionRow(kase.id, {
    rep: 1,
    railFirings: firingsOf({ "cc-delta": 1 }),
    files: { "thing.ts": correctedSource() },
  });
  const firedDpTwo = simulatedSessionRow(kase.id, {
    rep: 2,
    railFirings: firingsOf({ "cc-delta": 1 }),
    files: { "thing.ts": draftSource() },
  });
  const unfired = simulatedSessionRow(kase.id, { rep: 3, files: { "thing.ts": draftSource() } });

  const summary = await summarizeSimulatedSession([firedDpOne, firedDpTwo, unfired], [kase], corpusDir);

  assert.equal(summary[0]!.meanFinalDp, 1.5);
});

test("summarizeSimulatedSession_reports_meanFinalDp_as_null_when_no_rep_fired", async () => {
  const kase = fixtureCase();
  const corpusDir = tempCorpusWithDraft(kase, draftSource());
  const unfired = simulatedSessionRow(kase.id, { rep: 1 });

  const summary = await summarizeSimulatedSession([unfired], [kase], corpusDir);

  assert.equal(summary[0]!.meanFinalDp, null);
  assert.equal(summary[0]!.fired, 0);
});

test("summarizeSimulatedSession_groups_reps_into_one_summary_row_per_condition", async () => {
  const kase = fixtureCase();
  const corpusDir = tempCorpusWithDraft(kase, draftSource());
  const armA = simulatedSessionRow(kase.id, { conditionId: "arm-a" });
  const armB = simulatedSessionRow(kase.id, { conditionId: "arm-b" });

  const summary = await summarizeSimulatedSession([armA, armB], [kase], corpusDir);

  assert.deepEqual(
    summary.map((r) => r.conditionId).sort(),
    ["arm-a", "arm-b"],
  );
});

test("summarizeSimulatedSession_rejects_with_a_clear_error_when_a_row_has_no_files_snapshot", async () => {
  const kase = fixtureCase();
  const corpusDir = tempCorpusWithDraft(kase, draftSource());
  const wellFormed = simulatedSessionRow(kase.id);
  const malformed = JSON.parse(JSON.stringify({ ...wellFormed, files: undefined })) as RawRow;

  await assert.rejects(() => summarizeSimulatedSession([malformed], [kase], corpusDir), /no files snapshot/);
});

test("summarizeSimulatedSession_rejects_with_a_clear_error_naming_the_case_when_it_has_no_prior_draft_file_on_disk", async () => {
  const kase = fixtureCase();
  const corpusDir = tempDir("eval-simulated-session-score-corpus-");
  const row = simulatedSessionRow(kase.id);

  await assert.rejects(() => summarizeSimulatedSession([row], [kase], corpusDir), new RegExp(kase.id));
});

function rowWithoutSimulatedSessionMarker(caseId: string): RawRow {
  const { simulatedSession: _drop, ...rest } = simulatedSessionRow(caseId);
  return rest;
}

test("isSimulatedSessionRun_is_true_when_any_row_carries_the_simulatedSession_marker", () => {
  const marked = simulatedSessionRow("any-case");
  const unmarked = rowWithoutSimulatedSessionMarker("any-case");

  assert.equal(isSimulatedSessionRun([unmarked, marked]), true);
});

test("isSimulatedSessionRun_is_false_when_no_row_carries_the_marker", () => {
  const unmarked = rowWithoutSimulatedSessionMarker("any-case");

  assert.equal(isSimulatedSessionRun([unmarked]), false);
});

function assertSimulatedSessionValidityReported(result: { status: number; stdout: string }, fired: number, total: number): void {
  assert.equal(result.status, 0);
  assert.match(result.stdout, /simulated-session validity:/);
  assert.match(result.stdout, new RegExp(`fired=${fired}/${total}`));
}

test("runSimulatedSessionScore_prints_the_simulated_session_validity_block_with_the_fired_rate", async () => {
  const kase = fixtureCase();
  const corpusDir = tempCorpusWithDraft(kase, draftSource());
  const runDir = tempDir("eval-simulated-session-score-run-");
  const fired = simulatedSessionRow(kase.id, {
    rep: 1,
    railFirings: firingsOf({ "cc-delta": 1 }),
    files: { "thing.ts": correctedSource() },
  });
  const unfired = simulatedSessionRow(kase.id, { rep: 2 });

  const result = await runSimulatedSessionScore([fired, unfired], [kase], corpusDir, runDir);

  assertSimulatedSessionValidityReported(result, 1, 2);
});

function summaryRows(runDir: string): SimulatedSessionSummaryRow[] {
  const content = readFileSync(join(runDir, "summary.jsonl"), "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SimulatedSessionSummaryRow);
}

test("runSimulatedSessionScore_writes_a_summary_jsonl_row_per_condition_carrying_conditionId_fired_corrected_total_and_meanFinalDp", async () => {
  const kase = fixtureCase();
  const corpusDir = tempCorpusWithDraft(kase, draftSource());
  const runDir = tempDir("eval-simulated-session-score-run-");
  const fired = simulatedSessionRow(kase.id, {
    rep: 1,
    railFirings: firingsOf({ "cc-delta": 1 }),
    files: { "thing.ts": correctedSource() },
  });

  await runSimulatedSessionScore([fired], [kase], corpusDir, runDir);

  const [row] = summaryRows(runDir);
  assert.deepEqual(row, { conditionId: "rails-default", fired: 1, corrected: 1, total: 1, meanFinalDp: 1 });
});

test("runSimulatedSessionScore_reports_status_1_with_the_guard_rail_error_instead_of_crashing", async () => {
  const kase = fixtureCase();
  const corpusDir = tempDir("eval-simulated-session-score-corpus-");
  const runDir = tempDir("eval-simulated-session-score-run-");
  const row = simulatedSessionRow(kase.id);

  const result = await runSimulatedSessionScore([row], [kase], corpusDir, runDir);

  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(kase.id));
});
