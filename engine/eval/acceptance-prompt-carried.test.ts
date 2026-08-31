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
import { formatCcDeltaNudge } from "../messages.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CORPUS_DIR = join(import.meta.dirname, "corpus");
const CONDITIONS_DIR = join(import.meta.dirname, "conditions");
const CONDITION_ID = "cc-delta-numberless-prompt";
const CASE_ID = "ts-flag-parser";

const CASE_TASK = caseTask();
const ARM_MESSAGE = armMessage();

interface CaseFacts {
  task: string;
  entrySymbol: string;
  baseline: { decisionPoints: number };
}

function caseFacts(): CaseFacts {
  return JSON.parse(readFileSync(join(CORPUS_DIR, CASE_ID, "manifest.json"), "utf8")) as CaseFacts;
}

function caseTask(): string {
  return caseFacts().task;
}

function armMessage(): string {
  const pack = JSON.parse(readFileSync(join(CONDITIONS_DIR, "packs", "cc-delta-numberless.json"), "utf8")) as { CC_DELTA_NUDGE: string };
  const facts = caseFacts();
  return formatCcDeltaNudge(pack.CC_DELTA_NUDGE, {
    name: facts.entrySymbol,
    dpBefore: facts.baseline.decisionPoints,
    dpAfter: facts.baseline.decisionPoints,
  });
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function collectOpts(over: Partial<CollectOpts> = {}): CollectOpts {
  return {
    repoRoot: REPO_ROOT,
    runDir: tempDir("prompt-carried-run-"),
    workRoot: tempDir("prompt-carried-work-"),
    reps: 2,
    model: "claude-test-model",
    cases: [CASE_ID],
    conditions: [CONDITION_ID],
    corpusDir: CORPUS_DIR,
    conditionsDir: CONDITIONS_DIR,
    probeSpawner: healthyProbeReporter(),
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

async function collectPromptCarriedArm(spawner: PiSpawner, reps: number): Promise<{ result: CollectResult; runDir: string }> {
  const opts = collectOpts({ spawner, reps });
  const result = await runCollect(opts);
  return { result, runDir: opts.runDir };
}

async function scoreRun(runDir: string): Promise<{ status: number; stdout: string }> {
  return runScore({ runDir, corpusDir: CORPUS_DIR, repoRoot: REPO_ROOT, conditionsDir: CONDITIONS_DIR });
}

function stripTheArmMessageFromTheRecordedPrompt(runDir: string): void {
  const rawPath = join(runDir, "raw.jsonl");
  const rows = readFileSync(rawPath, "utf8").split("\n").filter((line) => line.length > 0);
  const tampered = rows.map((line) => {
    const row = JSON.parse(line) as Record<string, unknown>;
    return JSON.stringify({ ...row, task: CASE_TASK });
  });
  writeFileSync(rawPath, `${tampered.join("\n")}\n`);
}

function assertCollectSucceeded(result: CollectResult, reps: number): void {
  assert.equal(result.status, 0);
  assert.equal(result.rowsWritten, reps);
}

function assertEveryRepOpensWithTheCaseTaskAndTheArmMessage(calls: RunSpec[], reps: number): void {
  assert.equal(calls.length, reps);
  for (const spec of calls) {
    assert.ok(spec.task.includes(CASE_TASK), "opening prompt lost the case task");
    assert.ok(spec.task.includes(ARM_MESSAGE), "opening prompt does not carry the arm message");
  }
}

function assertTheLiveRailIsClosedForEveryRep(calls: RunSpec[]): void {
  for (const spec of calls) {
    assert.equal(spec.env.LIUBAI_RAILS_OFF, "1", "prompt-carried rep would also receive live rail nudges");
  }
}

function assertScoreVerifiesPromptDelivery(scored: { status: number; stdout: string }): void {
  assert.equal(scored.status, 0);
  assert.match(scored.stdout, /delivery validity:/);
  assert.match(scored.stdout, /delivered=prompt/);
  assert.doesNotMatch(scored.stdout, /unverifiable/);
}

function assertScoreRefuses(scored: { status: number; stdout: string }, violationKind: string): void {
  assert.equal(scored.status, 1);
  assert.match(scored.stdout, new RegExp(`\\[${violationKind}\\]`));
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

test("a_prompt_carried_arm_opens_every_rep_with_the_arm_message_and_scores_as_verified", async () => {
  const { spawner, calls } = recordingPiSpawner();

  const { result, runDir } = await collectPromptCarriedArm(spawner, 2);

  assertCollectSucceeded(result, 2);
  assertEveryRepOpensWithTheCaseTaskAndTheArmMessage(calls, 2);
  assertTheLiveRailIsClosedForEveryRep(calls);

  const scored = await scoreRun(runDir);

  assertScoreVerifiesPromptDelivery(scored);
  assertSummaryWritten(runDir);
  assertArmSummaryRowPresent(scored.stdout, CONDITION_ID);
});

test("a_run_whose_recorded_prompt_lacks_the_arm_message_is_refused_by_score", async () => {
  const { spawner } = recordingPiSpawner();
  const { result, runDir } = await collectPromptCarriedArm(spawner, 1);
  assertCollectSucceeded(result, 1);

  stripTheArmMessageFromTheRecordedPrompt(runDir);
  const scored = await scoreRun(runDir);

  assertScoreRefuses(scored, "prompt-not-carried");
  assertNoSummaryWritten(runDir);
});
