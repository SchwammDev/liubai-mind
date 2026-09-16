import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCollect } from "./collect.ts";
import type { CollectOpts, CollectResult } from "./collect.ts";
import type { RawRow } from "./eval-contract.ts";
import { runScore } from "./score.ts";
import type { RunSpec, RunOutcome, PiSpawner, ProbeSpawner } from "./spawner.ts";
import { RULE, nudgePhrasingHash } from "../contract.ts";
import type { RuleName } from "../contract.ts";
import type { ProbeReport } from "./canary.ts";
import { healthyProbeReporter } from "./probe-doubles.ts";
import { nudgeCounts, pristineSourceOf } from "./run-doubles.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CORPUS_DIR = join(import.meta.dirname, "corpus");
const TREATMENTS_DIR = join(import.meta.dirname, "treatments");
const TREATMENT_ID = "cc-delta-numberless";
const SHADOW_TREATMENT_ID = "cc-delta-shadow";
const CASE_ID = "ts-flag-parser";
const ENTRY_FILE = "parse_flags.ts";
const WRONG_NUDGE_PHRASING_HASH = "f".repeat(64);

type DeliveredStamp = NonNullable<RawRow["delivered"]>;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function collectOpts(over: Partial<CollectOpts> = {}): CollectOpts {
  return {
    repoRoot: REPO_ROOT,
    runDir: tempDir("acceptance-run-"),
    workRoot: tempDir("acceptance-work-"),
    repetitions: 1,
    model: "claude-test-model",
    cases: [CASE_ID],
    treatments: [TREATMENT_ID],
    corpusDir: CORPUS_DIR,
    treatmentsDir: TREATMENTS_DIR,
    ...over,
  };
}

function brokenDeliveryProbe(): ProbeSpawner {
  return async (spec) => {
    const outcome = await healthyProbeReporter()(spec);
    const report = JSON.parse(outcome.stdout) as ProbeReport;
    return { ...outcome, stdout: `${JSON.stringify({ ...report, nudgePhrasingHash: WRONG_NUDGE_PHRASING_HASH })}\n` };
  };
}

function ccDeltaTextOfPhrasing(nudgePhrasing: string): string {
  return (JSON.parse(nudgePhrasing) as { CC_DELTA_NUDGE?: string }).CC_DELTA_NUDGE ?? "";
}

function firedNudgeMarkerTranscript(rule: string, text: string): string {
  const result = { content: [{ type: "text", text: `\n\n[${rule}] ${text}` }] };
  return `${JSON.stringify({ type: "tool_execution_end", toolCallId: "1", toolName: "edit", result, isError: false })}\n`;
}

function railReportedDelivery(stamp: DeliveredStamp): string {
  return JSON.stringify({ type: "delivered", ...stamp });
}

function railReportedShadowNudge(rule: RuleName): string {
  return JSON.stringify({ type: "shadow", rule, path: ENTRY_FILE });
}

function railReport(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function agentExited(over: Partial<RunOutcome>): RunOutcome {
  return { exitCode: 0, stdoutJsonl: "", timedOut: false, ...over };
}

function liveCcDeltaStamp(stampedNudgePhrasingHash: string | null): DeliveredStamp {
  return { nudgePhrasingHash: stampedNudgePhrasingHash, liveRules: [RULE.ccDelta], shadowRules: [] };
}

function repetitionThatDeliversTheNudgePhrasing(): PiSpawner {
  return async (spec) => {
    const nudgePhrasing = spec.env.LIUBAI_NUDGE_PHRASING ?? "";
    return agentExited({
      stdoutJsonl: firedNudgeMarkerTranscript(RULE.ccDelta, ccDeltaTextOfPhrasing(nudgePhrasing)),
      railReportJsonl: railReport([railReportedDelivery(liveCcDeltaStamp(nudgePhrasingHash(nudgePhrasing)))]),
    });
  };
}

function repetitionThatDeliversAWrongNudgePhrasingHash(): PiSpawner {
  return async (spec) => {
    const nudgePhrasing = spec.env.LIUBAI_NUDGE_PHRASING ?? "";
    return agentExited({
      stdoutJsonl: firedNudgeMarkerTranscript(RULE.ccDelta, ccDeltaTextOfPhrasing(nudgePhrasing)),
      railReportJsonl: railReport([railReportedDelivery(liveCcDeltaStamp(WRONG_NUDGE_PHRASING_HASH))]),
    });
  };
}

const SHADOWED_CC_DELTA_STAMP: DeliveredStamp = { nudgePhrasingHash: null, liveRules: [], shadowRules: [RULE.ccDelta] };
const SHADOW_NUDGES_FIRED = 2;

function wipeEverythingIn(workDir: string): void {
  for (const entry of readdirSync(workDir)) rmSync(join(workDir, entry), { recursive: true, force: true });
}

function agentsOwnFiles(): Record<string, string> {
  return { [ENTRY_FILE]: pristineSourceOf(CASE_ID, ENTRY_FILE) };
}

function repetitionThatWipesTheWorkdirAfterTheRailLoaded(): PiSpawner {
  return async (spec) => {
    const reported = [
      railReportedDelivery(SHADOWED_CC_DELTA_STAMP),
      ...Array.from({ length: SHADOW_NUDGES_FIRED }, () => railReportedShadowNudge(RULE.ccDelta)),
    ];
    wipeEverythingIn(spec.cwd);
    for (const [name, content] of Object.entries(agentsOwnFiles())) writeFileSync(join(spec.cwd, name), content);
    return agentExited({ railReportJsonl: railReport(reported) });
  };
}

function recordingPiSpawner(): { spawner: PiSpawner; calls: RunSpec[] } {
  const calls: RunSpec[] = [];
  const spawner: PiSpawner = async (spec) => {
    calls.push(spec);
    return agentExited({});
  };
  return { spawner, calls };
}

async function collectTreatmentWithANudgePhrasing(spawner: PiSpawner, probeSpawner: ProbeSpawner): Promise<{ result: CollectResult; runDir: string }> {
  const opts = collectOpts({ spawner, probeSpawner });
  const result = await runCollect(opts);
  return { result, runDir: opts.runDir };
}

async function collectShadowTreatment(spawner: PiSpawner): Promise<{ result: CollectResult; runDir: string }> {
  const opts = collectOpts({ spawner, probeSpawner: healthyProbeReporter(), treatments: [SHADOW_TREATMENT_ID] });
  const result = await runCollect(opts);
  return { result, runDir: opts.runDir };
}

async function scoreRun(runDir: string): Promise<{ status: number; stdout: string }> {
  return runScore({ runDir, corpusDir: CORPUS_DIR, repoRoot: REPO_ROOT, treatmentsDir: TREATMENTS_DIR });
}

function theOnlyRawRow(runDir: string): RawRow {
  const rows = readFileSync(join(runDir, "raw.jsonl"), "utf8").trim().split("\n");
  assert.equal(rows.length, 1);
  return JSON.parse(rows[0]!) as RawRow;
}

function deliveryEvidenceOn(row: RawRow): unknown {
  return { delivered: row.delivered, shadowNudges: row.shadowNudges };
}

function assertCollectSucceeded(result: CollectResult): void {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.rowsWritten, 1);
}

function assertScoreAccepts(result: { status: number; stdout: string }): void {
  assert.equal(result.status, 0, result.stdout);
}

function assertScoreRefuses(result: { status: number; stdout: string }, violationKind: string): void {
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`\\[${violationKind}\\]`));
}

function assertDeliveryValidityBlockPrinted(stdout: string): void {
  assert.match(stdout, /delivery validity:/);
}

function assertTreatmentSummaryRowPresent(stdout: string, treatmentId: string): void {
  assert.match(stdout, new RegExp(`\\| ${treatmentId} \\|`));
}

function assertSummaryWritten(runDir: string): void {
  assert.ok(existsSync(join(runDir, "summary.jsonl")));
}

function assertNoSummaryWritten(runDir: string): void {
  assert.equal(existsSync(join(runDir, "summary.jsonl")), false);
}

function assertCollectAbortedAtCanary(result: CollectResult, treatmentId: string): void {
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(treatmentId));
}

function assertRepetitionSpawnerNeverInvoked(calls: unknown[]): void {
  assert.equal(calls.length, 0);
}

function assertNoRawRowWritten(runDir: string): void {
  assert.equal(existsSync(join(runDir, "raw.jsonl")), false);
}

test("a_delivered_nudge_phrasing_scores_with_a_verified_delivery_validity_block", async () => {
  const { result, runDir } = await collectTreatmentWithANudgePhrasing(repetitionThatDeliversTheNudgePhrasing(), healthyProbeReporter());
  assertCollectSucceeded(result);

  const scored = await scoreRun(runDir);

  assertScoreAccepts(scored);
  assertSummaryWritten(runDir);
  assertDeliveryValidityBlockPrinted(scored.stdout);
  assertTreatmentSummaryRowPresent(scored.stdout, TREATMENT_ID);
});

test("an_undelivered_nudge_phrasing_is_refused_by_score", async () => {
  const { result, runDir } = await collectTreatmentWithANudgePhrasing(repetitionThatDeliversAWrongNudgePhrasingHash(), healthyProbeReporter());
  assertCollectSucceeded(result);

  const scored = await scoreRun(runDir);

  assertScoreRefuses(scored, "not-delivered");
  assertNoSummaryWritten(runDir);
});

test("broken_delivery_aborts_the_run_at_the_canary_before_any_repetition_runs", async () => {
  const { spawner, calls } = recordingPiSpawner();

  const { result, runDir } = await collectTreatmentWithANudgePhrasing(spawner, brokenDeliveryProbe());

  assertCollectAbortedAtCanary(result, TREATMENT_ID);
  assertRepetitionSpawnerNeverInvoked(calls);
  assertNoRawRowWritten(runDir);
});

test("the_delivery_verdict_survives_the_agent_wiping_its_workdir", async () => {
  const { result, runDir } = await collectShadowTreatment(repetitionThatWipesTheWorkdirAfterTheRailLoaded());

  assertCollectSucceeded(result);
  assert.deepEqual(deliveryEvidenceOn(theOnlyRawRow(runDir)), {
    delivered: SHADOWED_CC_DELTA_STAMP,
    shadowNudges: nudgeCounts({ [RULE.ccDelta]: SHADOW_NUDGES_FIRED }),
  });
  assertScoreAccepts(await scoreRun(runDir));
});
