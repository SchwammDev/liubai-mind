import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runCollect } from "./collect.ts";
import type { CollectOpts } from "./collect.ts";
import { runScore } from "./score.ts";
import type { Provenance, RawRow } from "./eval-contract.ts";
import type { PiSpawner, RunSpec } from "./spawner.ts";
import { healthyProbeReporter } from "./probe-doubles.ts";
import {
  CORPUS_DIR,
  TREATMENTS_DIR,
  assistantSaid,
  assistantThought,
  nudgeCounts,
  pristineSourceOf,
  sessionLog,
  singleTaskSessionLogName,
  tempDir,
  turnStart,
  writeRun,
} from "./run-doubles.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const CASE_ID = "ts-flag-parser";
const ENTRY_FILE = "parse_flags.ts";
const TREATMENT_ID = "control";
const MODEL = "aqueduct/deepseek-v4-flash-284b";
const REASONING_LEVEL = "high";

const COLLECTED_BEFORE_REASONING_WAS_ASKED_FOR = 1;
const ASKED_FOR_BUT_NONE_RETURNED = 2;
const ASKED_FOR_AND_RETURNED = 3;

type ReportRecord = Record<string, unknown>;

function collectOpts(over: Partial<CollectOpts> = {}): CollectOpts {
  return {
    repoRoot: REPO_ROOT,
    runDir: tempDir("reasoning-run-"),
    workRoot: tempDir("reasoning-work-"),
    repetitions: 1,
    model: MODEL,
    cases: [CASE_ID],
    treatments: [TREATMENT_ID],
    corpusDir: CORPUS_DIR,
    treatmentsDir: TREATMENTS_DIR,
    probeSpawner: healthyProbeReporter(),
    ...over,
  } as unknown as CollectOpts;
}

function spawnerRecordingWhatWasAskedOfTheAgent(asked: RunSpec[]): PiSpawner {
  return async (spec) => {
    asked.push(spec);
    return { exitCode: 0, stdoutJsonl: sessionLog([turnStart(), assistantSaid("done")]), timedOut: false };
  };
}

function reasoningLevelsAskedOfTheAgent(asked: RunSpec[]): unknown[] {
  return asked.map((spec) => (spec as unknown as Record<string, unknown>)["reasoning"]);
}

function rawRowsOf(runDir: string): RawRow[] {
  return readFileSync(join(runDir, "raw.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RawRow);
}

function reasoningLevelsRecordedOnTheRows(runDir: string): unknown[] {
  return rawRowsOf(runDir).map((row) => (row.provenance as unknown as Record<string, unknown>)["reasoning"]);
}

function recordsOf(runDir: string): ReportRecord[] {
  const path = join(runDir, "judged.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ReportRecord);
}

function reasoningReportedForSession(records: ReportRecord[], repetition: number): unknown {
  const found = records.filter((record) => record["repetition"] === repetition);
  assert.equal(found.length, 1, `expected one record for session ${repetition}`);
  return found[0]!["reasoning"];
}

function reasoningReportedForEachSession(records: ReportRecord[]): unknown {
  return {
    collectedBeforeReasoningWasAskedFor: reasoningReportedForSession(records, COLLECTED_BEFORE_REASONING_WAS_ASKED_FOR),
    askedForButNoneReturned: reasoningReportedForSession(records, ASKED_FOR_BUT_NONE_RETURNED),
    askedForAndReturned: reasoningReportedForSession(records, ASKED_FOR_AND_RETURNED),
  };
}

function provenanceThatAskedFor(level: string | null): Provenance {
  const asCollected = {
    treatmentId: TREATMENT_ID,
    phrasingPackHash: null,
    liubaiSha: "3250ea4",
    model: MODEL,
    collectedAt: "2026-09-05T00:00:00.000Z",
  };
  return (level === null ? asCollected : { ...asCollected, reasoning: level }) as Provenance;
}

function collectedRow(repetition: number, reasoningAskedFor: string | null): RawRow {
  return {
    caseId: CASE_ID,
    treatmentId: TREATMENT_ID,
    repetition,
    provenance: provenanceThatAskedFor(reasoningAskedFor),
    files: { [ENTRY_FILE]: pristineSourceOf(CASE_ID, ENTRY_FILE) },
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    turns: 1,
    tokensIn: 100,
    tokensOut: 20,
    nudges: nudgeCounts({}),
  };
}

function runWhoseThreeSessionsDifferInReasoning(): string {
  const rows = [
    collectedRow(COLLECTED_BEFORE_REASONING_WAS_ASKED_FOR, null),
    collectedRow(ASKED_FOR_BUT_NONE_RETURNED, REASONING_LEVEL),
    collectedRow(ASKED_FOR_AND_RETURNED, REASONING_LEVEL),
  ];
  const spoke = sessionLog([turnStart(), assistantSaid("done")]);
  const thought = sessionLog([turnStart(), assistantThought("weighing the two shapes"), assistantSaid("done")]);

  return writeRun(tempDir("reasoning-score-"), rows, {
    [singleTaskSessionLogName(CASE_ID, TREATMENT_ID, COLLECTED_BEFORE_REASONING_WAS_ASKED_FOR)]: spoke,
    [singleTaskSessionLogName(CASE_ID, TREATMENT_ID, ASKED_FOR_BUT_NONE_RETURNED)]: spoke,
    [singleTaskSessionLogName(CASE_ID, TREATMENT_ID, ASKED_FOR_AND_RETURNED)]: thought,
  });
}

async function scoreRun(runDir: string): Promise<ReportRecord[]> {
  const result = await runScore({ runDir, corpusDir: CORPUS_DIR, repoRoot: REPO_ROOT, treatmentsDir: TREATMENTS_DIR });
  assert.equal(result.status, 0, result.stdout);
  return recordsOf(runDir);
}

test("collect asks the agent for reasoning and records the level it asked for", async () => {
  const asked: RunSpec[] = [];
  const opts = collectOpts({ spawner: spawnerRecordingWhatWasAskedOfTheAgent(asked) });

  await runCollect(opts);

  assert.deepEqual(
    { askedOfTheAgent: reasoningLevelsAskedOfTheAgent(asked), recordedOnTheRows: reasoningLevelsRecordedOnTheRows(opts.runDir) },
    { askedOfTheAgent: [REASONING_LEVEL], recordedOnTheRows: [REASONING_LEVEL] },
  );
});

test("a record tells apart reasoning never asked for, asked for and absent, and asked for and returned", async () => {
  const runDir = runWhoseThreeSessionsDifferInReasoning();

  const records = await scoreRun(runDir);

  assert.deepEqual(reasoningReportedForEachSession(records), {
    collectedBeforeReasoningWasAskedFor: { requested: null, present: false },
    askedForButNoneReturned: { requested: REASONING_LEVEL, present: false },
    askedForAndReturned: { requested: REASONING_LEVEL, present: true },
  });
});
