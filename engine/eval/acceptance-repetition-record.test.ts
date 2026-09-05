import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runEval } from "./eval-cli.ts";
import { runScore } from "./score.ts";
import { routeScore } from "./follow-up-score.ts";
import type { RawRow } from "./eval-contract.ts";
import { RULE } from "../contract.ts";
import {
  CORPUS_DIR,
  TREATMENTS_DIR,
  followUpSessionLogName,
  nudgeCounts,
  nudgeFired,
  pristineSourceOf,
  sessionLog,
  singleTaskSessionLogName,
  tempDir,
  toolCall,
  turnStart,
  writeRun,
} from "./run-doubles.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const RUNS_ROOT = join(import.meta.dirname, "runs");

const COMMITTED_RUN = "numberless-prompt-v2-hard-flash";
const SESSIONS_IN_THE_COMMITTED_RUN = 144;

const CASE_ID = "ts-flag-parser";
const ENTRY_FILE = "parse_flags.ts";
const TREATMENT_ID = "rails-default";
const EARLIER_RUN = "earlier-run";
const ONLY_REPETITION = 1;
const REPETITION_STARTED_FROM_THE_EARLIER_RESULT = 3;
const REPETITION_STARTED_FROM_THE_ORIGINAL_SOURCE = 1;

const FACTS_THE_REPORT_NEEDS = [
  "caseId",
  "treatmentId",
  "repetition",
  "startsFrom",
  "transcriptPath",
  "verdict",
  "gamedReason",
  "failedBehaviorChecks",
  "decisionPointsBefore",
  "decisionPointsAfter",
  "entrySymbolComplexityBefore",
  "entrySymbolComplexityAfter",
  "functionsBefore",
  "functionsAfter",
  "linesAdded",
  "linesRemoved",
  "turns",
  "tokensIn",
  "tokensOut",
  "durationMs",
  "ending",
  "retries",
  "nudges",
  "toolCalls",
  "firstEditTurn",
  "filesCreated",
  "reasoning",
  "contaminated",
  "consultedRail",
];

type ReportRecord = Record<string, unknown>;

function recordsOf(runDir: string): ReportRecord[] {
  const path = join(runDir, "judged.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ReportRecord);
}

function factsOnEachOf(records: ReportRecord[]): string[][] {
  return records.map((record) => Object.keys(record).sort());
}

function everySessionCarriesEveryFact(sessions: number): string[][] {
  return Array.from({ length: sessions }, () => [...FACTS_THE_REPORT_NEEDS].sort());
}

function recordOfSession(records: ReportRecord[], repetition: number): ReportRecord {
  const found = records.filter((record) => record["repetition"] === repetition);
  assert.equal(found.length, 1, `expected one record for session ${repetition}`);
  return found[0]!;
}

function whereTheSessionWasNudgedAndFirstEdited(record: ReportRecord): unknown {
  const nudges = record["nudges"] as Record<string, unknown>;
  return { complexityNudges: nudges[RULE.ccDelta], firstEditOnTurn: record["firstEditTurn"] };
}

function whatEachSessionStartedFrom(records: ReportRecord[]): unknown {
  return {
    builtOnTheEarlierResult: recordOfSession(records, REPETITION_STARTED_FROM_THE_EARLIER_RESULT)["startsFrom"],
    builtOnTheOriginalSource: recordOfSession(records, REPETITION_STARTED_FROM_THE_ORIGINAL_SOURCE)["startsFrom"],
  };
}

function sessionThatEditsOnTurnsTwoAndFourAndIsNudgedBothTimes(): string {
  return sessionLog([
    turnStart(), toolCall("read"),
    turnStart(), toolCall("edit"), nudgeFired(RULE.ccDelta),
    turnStart(), toolCall("read"),
    turnStart(), toolCall("edit"), nudgeFired(RULE.ccDelta),
  ]);
}

function collectedRow(over: Partial<RawRow> = {}): RawRow {
  return {
    caseId: CASE_ID,
    treatmentId: TREATMENT_ID,
    repetition: ONLY_REPETITION,
    provenance: {
      treatmentId: TREATMENT_ID,
      phrasingPackHash: null,
      liubaiSha: "3250ea4",
      model: "aqueduct/deepseek-v4-flash-284b",
      collectedAt: "2026-09-05T00:00:00.000Z",
    },
    files: { [ENTRY_FILE]: pristineSourceOf(CASE_ID, ENTRY_FILE) },
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    turns: 4,
    tokensIn: 100,
    tokensOut: 20,
    nudges: nudgeCounts({ [RULE.ccDelta]: 2 }),
    ...over,
  };
}

function singleTaskRunWhoseSessionEditsTwice(): string {
  return writeRun(tempDir("record-single-task-"), [collectedRow()], {
    [singleTaskSessionLogName(CASE_ID, TREATMENT_ID, ONLY_REPETITION)]: sessionThatEditsOnTurnsTwoAndFourAndIsNudgedBothTimes(),
  });
}

function earlierRunHoldingTheResultToBuildOn(): string {
  const runsRoot = tempDir("record-earlier-runs-");
  const earlierResult = collectedRow({ repetition: REPETITION_STARTED_FROM_THE_EARLIER_RESULT });
  writeRun(join(runsRoot, EARLIER_RUN), [earlierResult], {});
  return runsRoot;
}

function followUpRunWithOneRepetitionFromEachStartingPoint(): string {
  const builtOnTheEarlierResult = collectedRow({
    repetition: REPETITION_STARTED_FROM_THE_EARLIER_RESULT,
    followUp: { sourceRun: EARLIER_RUN, sourceRepetition: REPETITION_STARTED_FROM_THE_EARLIER_RESULT, control: false },
  });
  const builtOnTheOriginalSource = collectedRow({
    repetition: REPETITION_STARTED_FROM_THE_ORIGINAL_SOURCE,
    followUp: { sourceRun: EARLIER_RUN, sourceRepetition: null, control: true },
  });

  const session = sessionThatEditsOnTurnsTwoAndFourAndIsNudgedBothTimes();
  return writeRun(tempDir("record-follow-up-"), [builtOnTheEarlierResult, builtOnTheOriginalSource], {
    [followUpSessionLogName(CASE_ID, TREATMENT_ID, REPETITION_STARTED_FROM_THE_EARLIER_RESULT)]: session,
    [followUpSessionLogName(CASE_ID, TREATMENT_ID, null)]: session,
  });
}

async function scoreTheCommittedRun(): Promise<ReportRecord[]> {
  const result = await runEval(["score", "--run", COMMITTED_RUN]);
  assert.equal(result.status, 0, result.stdout);
  return recordsOf(join(RUNS_ROOT, COMMITTED_RUN));
}

async function scoreSingleTaskRun(runDir: string): Promise<ReportRecord[]> {
  const result = await runScore({ runDir, corpusDir: CORPUS_DIR, repoRoot: REPO_ROOT, treatmentsDir: TREATMENTS_DIR });
  assert.equal(result.status, 0, result.stdout);
  return recordsOf(runDir);
}

async function scoreFollowUpRun(runDir: string, runsRoot: string): Promise<ReportRecord[]> {
  const opts = { runDir, corpusDir: CORPUS_DIR, repoRoot: REPO_ROOT, treatmentsDir: TREATMENTS_DIR };
  const result = await routeScore(opts, runsRoot);
  assert.equal(result.status, 0, result.stdout);
  return recordsOf(runDir);
}

test("scoring the committed run gives every session a record carrying the facts the report needs", async () => {
  const records = await scoreTheCommittedRun();

  assert.deepEqual(factsOnEachOf(records), everySessionCarriesEveryFact(SESSIONS_IN_THE_COMMITTED_RUN));
});

test("a record names the turns the nudges fired on and the turn of the first edit", async () => {
  const runDir = singleTaskRunWhoseSessionEditsTwice();

  const records = await scoreSingleTaskRun(runDir);

  assert.deepEqual(whereTheSessionWasNudgedAndFirstEdited(recordOfSession(records, ONLY_REPETITION)), {
    complexityNudges: { count: 2, turns: [2, 4] },
    firstEditOnTurn: 2,
  });
});

test("a follow-up run is judged into records carrying the same facts as a single-task run", async () => {
  const runsRoot = earlierRunHoldingTheResultToBuildOn();
  const runDir = followUpRunWithOneRepetitionFromEachStartingPoint();

  const records = await scoreFollowUpRun(runDir, runsRoot);

  assert.deepEqual(factsOnEachOf(records), everySessionCarriesEveryFact(2));
});

test("a follow-up record names the earlier result it built on, and a control record names the original source", async () => {
  const runsRoot = earlierRunHoldingTheResultToBuildOn();
  const runDir = followUpRunWithOneRepetitionFromEachStartingPoint();

  const records = await scoreFollowUpRun(runDir, runsRoot);

  assert.deepEqual(whatEachSessionStartedFrom(records), {
    builtOnTheEarlierResult: {
      kind: "earlier-result",
      sourceRun: EARLIER_RUN,
      sourceRepetition: REPETITION_STARTED_FROM_THE_EARLIER_RESULT,
    },
    builtOnTheOriginalSource: { kind: "original-source" },
  });
});
