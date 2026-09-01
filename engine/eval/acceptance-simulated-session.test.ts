import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCollect } from "./collect.ts";
import type { CollectOpts, CollectResult } from "./collect.ts";
import { runScore } from "./score.ts";
import type { RunSpec, PiSpawner } from "./spawner.ts";
import { healthyProbeReporter } from "./probe-doubles.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CORPUS_DIR = join(import.meta.dirname, "corpus");
const CONDITIONS_DIR = join(import.meta.dirname, "conditions");
const CONDITION_ID = "cc-delta-numberless";
const CASE_ID = "ts-telemetry-pipeline";

function originalImproveTask(): string {
  const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, CASE_ID, "manifest.json"), "utf8")) as { task: string };
  return manifest.task;
}

function extensionTask(): string {
  const extension = JSON.parse(readFileSync(join(CORPUS_DIR, CASE_ID, "extension.json"), "utf8")) as { task: string };
  return extension.task;
}

function priorDraft(): string {
  return readFileSync(join(CORPUS_DIR, CASE_ID, "prior-draft.ts"), "utf8");
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function collectOpts(over: Partial<CollectOpts> = {}): CollectOpts {
  return {
    repoRoot: REPO_ROOT,
    runDir: tempDir("simulated-session-run-"),
    workRoot: tempDir("simulated-session-work-"),
    reps: 2,
    model: "claude-test-model",
    cases: [CASE_ID],
    conditions: [CONDITION_ID],
    corpusDir: CORPUS_DIR,
    conditionsDir: CONDITIONS_DIR,
    probeSpawner: healthyProbeReporter(),
    simulatedSession: true,
    ...over,
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

async function collectSimulatedSessionArm(spawner: PiSpawner, reps: number): Promise<{ result: CollectResult; runDir: string }> {
  const opts = collectOpts({ spawner, reps });
  const result = await runCollect(opts);
  return { result, runDir: opts.runDir };
}

async function scoreRun(runDir: string): Promise<{ status: number; stdout: string }> {
  return runScore({ runDir, corpusDir: CORPUS_DIR, repoRoot: REPO_ROOT, conditionsDir: CONDITIONS_DIR });
}

function markTheScriptedWriteAsFiredOnTheFirstRep(runDir: string): void {
  const rawPath = join(runDir, "raw.jsonl");
  const rows = readFileSync(rawPath, "utf8").split("\n").filter((line) => line.length > 0);
  const first = JSON.parse(rows[0]!) as Record<string, unknown>;
  const edited = [JSON.stringify({ ...first, railFirings: { "cc-delta": 1 } }), ...rows.slice(1)];
  writeFileSync(rawPath, `${edited.join("\n")}\n`);
}

function assertCollectSucceeded(result: CollectResult, reps: number): void {
  assert.equal(result.status, 0);
  assert.equal(result.rowsWritten, reps);
}

function assertEveryRepOpensWithTheHonestFrameDraftAndExtension(calls: RunSpec[], reps: number): void {
  assert.equal(calls.length, reps);
  for (const spec of calls) {
    assert.ok(spec.task.includes("simulated"), "opening prompt does not disclose the simulation");
    assert.ok(spec.task.includes("research"), "opening prompt does not disclose the research purpose");
    assert.ok(spec.task.includes("wrote earlier"), "opening prompt does not hand the draft to the agent as its own earlier work");
    assert.ok(spec.task.includes(priorDraft()), "opening prompt does not carry the prior draft to write");
    assert.ok(spec.task.includes(extensionTask()), "opening prompt does not carry the follow-on extension task");
    assert.ok(!spec.task.includes(originalImproveTask()), "opening prompt leaks an improvement instruction");
  }
}

function assertTheLiveRailIsOpenForEveryRep(calls: RunSpec[]): void {
  for (const spec of calls) {
    assert.equal(spec.env.LIUBAI_RAILS_OFF, undefined, "simulated-session rep runs with the live rail closed");
  }
}

function assertScoreReportsTheFiredRate(scored: { status: number; stdout: string }, fired: number, total: number): void {
  assert.equal(scored.status, 0);
  assert.match(scored.stdout, /simulated-session validity:/);
  assert.match(scored.stdout, new RegExp(`fired=${fired}/${total}`));
}

function summaryRows(runDir: string): Record<string, unknown>[] {
  const content = readFileSync(join(runDir, "summary.jsonl"), "utf8");
  return content.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function assertCorrectedRateIsComputedOverFiredRepsOnly(runDir: string): void {
  assert.ok(existsSync(join(runDir, "summary.jsonl")));
  const armRow = summaryRows(runDir).find((row) => row.conditionId === CONDITION_ID);
  assert.ok(armRow !== undefined, "no summary row for the simulated-session arm");
  assert.equal(armRow.fired, 1, "corrected-rate denominator is not the fired reps");
  assert.equal(armRow.corrected, 0, "an untouched rep counts as corrected");
}

test("a_simulated_session_rep_opens_with_the_honest_frame_the_prior_draft_and_the_extension_task_on_a_live_rail", async () => {
  const { spawner, calls } = recordingPiSpawner();

  const { result } = await collectSimulatedSessionArm(spawner, 2);

  assertCollectSucceeded(result, 2);
  assertEveryRepOpensWithTheHonestFrameDraftAndExtension(calls, 2);
  assertTheLiveRailIsOpenForEveryRep(calls);
});

test("a_simulated_session_run_reports_the_fired_rate_and_computes_the_corrected_rate_over_fired_reps_only", async () => {
  const { spawner } = recordingPiSpawner();
  const { result, runDir } = await collectSimulatedSessionArm(spawner, 2);
  assertCollectSucceeded(result, 2);

  markTheScriptedWriteAsFiredOnTheFirstRep(runDir);
  const scored = await scoreRun(runDir);

  assertScoreReportsTheFiredRate(scored, 1, 2);
  assertCorrectedRateIsComputedOverFiredRepsOnly(runDir);
});
