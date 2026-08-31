import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCollect } from "./collect.ts";
import type { CollectOpts, CollectResult } from "./collect.ts";
import { runScore } from "./score.ts";
import type { RunSpec, PiSpawner, ProbeSpawner } from "./spawner.ts";
import { RULE, packHash } from "../contract.ts";
import { CC_DELTA_NUDGE, CC_NUDGE, formatCcNudge } from "../messages.ts";
import { DEFAULT_POLICY } from "../policy.ts";
import { PROBE_FIXTURES } from "../delivery-probe.ts";
import type { ProbeReport } from "./canary.ts";
import { validatePack } from "./phrasing.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CORPUS_DIR = join(import.meta.dirname, "corpus");
const CONDITIONS_DIR = join(import.meta.dirname, "conditions");
const CONDITION_ID = "cc-delta-numberless";
const CASE_ID = "ts-flag-parser";
const WRONG_PACK_HASH = "f".repeat(64);

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function collectOpts(over: Partial<CollectOpts> = {}): CollectOpts {
  return {
    repoRoot: REPO_ROOT,
    runDir: tempDir("acceptance-run-"),
    workRoot: tempDir("acceptance-work-"),
    reps: 1,
    model: "claude-test-model",
    cases: [CASE_ID],
    conditions: [CONDITION_ID],
    corpusDir: CORPUS_DIR,
    conditionsDir: CONDITIONS_DIR,
    ...over,
  };
}

function healthyProbeReporter(): ProbeSpawner {
  return async (spec) => {
    const packContent = spec.env.LIUBAI_PHRASING_PACK;
    const validated = packContent === undefined ? undefined : validatePack(packContent);
    const pack = validated !== undefined && "pack" in validated ? validated.pack : {};

    const nudges: Partial<Record<"python" | "typescript", string[]>> = {};
    for (const fixture of PROBE_FIXTURES) {
      const entry = pack.CC_NUDGE?.[fixture.lang] ?? CC_NUDGE[fixture.lang];
      const threshold = DEFAULT_POLICY[RULE.cc].threshold?.[fixture.lang] ?? 8;
      nudges[fixture.lang] = [formatCcNudge(entry.first, { name: fixture.functionName, cc: fixture.cyclomaticComplexity, threshold })];
    }

    const report: ProbeReport = {
      packHash: packHash(packContent ?? null),
      nudges,
      errors: [],
      ccNudge: {
        python: pack.CC_NUDGE?.python ?? CC_NUDGE.python,
        typescript: pack.CC_NUDGE?.typescript ?? CC_NUDGE.typescript,
        cpp: pack.CC_NUDGE?.cpp ?? CC_NUDGE.cpp,
      },
      ccDeltaNudge: pack.CC_DELTA_NUDGE ?? CC_DELTA_NUDGE,
    };

    return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "" };
  };
}

function brokenDeliveryProbe(): ProbeSpawner {
  return async (spec) => {
    const outcome = await healthyProbeReporter()(spec);
    const report = JSON.parse(outcome.stdout) as ProbeReport;
    return { ...outcome, stdout: `${JSON.stringify({ ...report, packHash: WRONG_PACK_HASH })}\n` };
  };
}

function ccDeltaTextOfPack(packContent: string): string {
  return (JSON.parse(packContent) as { CC_DELTA_NUDGE?: string }).CC_DELTA_NUDGE ?? "";
}

function firedNudgeMarkerTranscript(rule: string, text: string): string {
  const result = { content: [{ type: "text", text: `\n\n[${rule}] ${text}` }] };
  return `${JSON.stringify({ type: "tool_execution_end", toolCallId: "1", toolName: "edit", result, isError: false })}\n`;
}

function stampDeliveredPack(workDir: string, stampedPackHash: string | null): void {
  const liubaiDir = join(workDir, ".liubai");
  mkdirSync(liubaiDir, { recursive: true });
  const stamp = { packHash: stampedPackHash, liveRules: [RULE.ccDelta], shadowRules: [] };
  writeFileSync(join(liubaiDir, "delivered.json"), JSON.stringify(stamp));
}

function repThatDeliversThePack(): PiSpawner {
  return async (spec) => {
    const packContent = spec.env.LIUBAI_PHRASING_PACK ?? "";
    stampDeliveredPack(spec.cwd, packHash(packContent));
    const stdoutJsonl = firedNudgeMarkerTranscript(RULE.ccDelta, ccDeltaTextOfPack(packContent));
    return { exitCode: 0, stdoutJsonl, timedOut: false };
  };
}

function repThatDeliversAWrongPackHash(): PiSpawner {
  return async (spec) => {
    const packContent = spec.env.LIUBAI_PHRASING_PACK ?? "";
    stampDeliveredPack(spec.cwd, WRONG_PACK_HASH);
    const stdoutJsonl = firedNudgeMarkerTranscript(RULE.ccDelta, ccDeltaTextOfPack(packContent));
    return { exitCode: 0, stdoutJsonl, timedOut: false };
  };
}

function recordingPiSpawner(): { spawner: PiSpawner; calls: RunSpec[] } {
  const calls: RunSpec[] = [];
  const spawner: PiSpawner = async (spec) => {
    calls.push(spec);
    return { exitCode: 0, stdoutJsonl: "", timedOut: false };
  };
  return { spawner, calls };
}

async function collectPackedArm(spawner: PiSpawner, probeSpawner: ProbeSpawner): Promise<{ result: CollectResult; runDir: string }> {
  const opts = collectOpts({ spawner, probeSpawner });
  const result = await runCollect(opts);
  return { result, runDir: opts.runDir };
}

async function scoreRun(runDir: string): Promise<{ status: number; stdout: string }> {
  return runScore({ runDir, corpusDir: CORPUS_DIR, repoRoot: REPO_ROOT, conditionsDir: CONDITIONS_DIR });
}

function assertCollectSucceeded(result: CollectResult): void {
  assert.equal(result.status, 0);
  assert.equal(result.rowsWritten, 1);
}

function assertScoreAccepts(result: { status: number; stdout: string }): void {
  assert.equal(result.status, 0);
}

function assertScoreRefuses(result: { status: number; stdout: string }, violationKind: string): void {
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`\\[${violationKind}\\]`));
}

function assertDeliveryValidityBlockPrinted(stdout: string): void {
  assert.match(stdout, /delivery validity:/);
}

function assertArmSummaryRowPresent(stdout: string, conditionId: string): void {
  assert.match(stdout, new RegExp(`\\| ${conditionId} \\|`));
}

function assertSummaryWritten(runDir: string): void {
  assert.ok(existsSync(join(runDir, "summary.jsonl")));
}

function assertNoSummaryWritten(runDir: string): void {
  assert.equal(existsSync(join(runDir, "summary.jsonl")), false);
}

function assertCollectAbortedAtCanary(result: CollectResult, conditionId: string): void {
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(conditionId));
}

function assertRepSpawnerNeverInvoked(calls: unknown[]): void {
  assert.equal(calls.length, 0);
}

function assertNoRawRowWritten(runDir: string): void {
  assert.equal(existsSync(join(runDir, "raw.jsonl")), false);
}

test("a_delivered_packed_arm_scores_with_a_verified_delivery_validity_block", async () => {
  const { result, runDir } = await collectPackedArm(repThatDeliversThePack(), healthyProbeReporter());
  assertCollectSucceeded(result);

  const scored = await scoreRun(runDir);

  assertScoreAccepts(scored);
  assertSummaryWritten(runDir);
  assertDeliveryValidityBlockPrinted(scored.stdout);
  assertArmSummaryRowPresent(scored.stdout, CONDITION_ID);
});

test("an_undelivered_packed_arm_is_refused_by_score", async () => {
  const { result, runDir } = await collectPackedArm(repThatDeliversAWrongPackHash(), healthyProbeReporter());
  assertCollectSucceeded(result);

  const scored = await scoreRun(runDir);

  assertScoreRefuses(scored, "not-delivered");
  assertNoSummaryWritten(runDir);
});

test("broken_delivery_aborts_the_run_at_the_canary_before_any_rep_runs", async () => {
  const { spawner, calls } = recordingPiSpawner();

  const { result, runDir } = await collectPackedArm(spawner, brokenDeliveryProbe());

  assertCollectAbortedAtCanary(result, CONDITION_ID);
  assertRepSpawnerNeverInvoked(calls);
  assertNoRawRowWritten(runDir);
});
