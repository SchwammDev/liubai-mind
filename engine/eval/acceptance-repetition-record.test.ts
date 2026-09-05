import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

const CASE_ID = "ts-flag-parser";
const ENTRY_FILE = "parse_flags.ts";
const PYTHON_CASE_ID = "py-safe-convert";
const PYTHON_ENTRY_FILE = "to_number.py";

const TYPESCRIPT_HELPER = '\nfunction isFlag(token: string): boolean {\n  return token.startsWith("--");\n}\n';
const PYTHON_HELPER = '\n\ndef _is_blank(text: str) -> bool:\n    return text.strip() == ""\n';
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

type Session = { ending: string; row: RawRow };

function entryWithAnAddedHelper(caseId: string, entryFile: string, helper: string): Record<string, string> {
  return { [entryFile]: `${pristineSourceOf(caseId, entryFile)}${helper}` };
}

function sessionsCoveringEveryEnding(): Session[] {
  return [
    {
      ending: "changed the entry",
      row: collectedRow({ repetition: 1, files: entryWithAnAddedHelper(CASE_ID, ENTRY_FILE, TYPESCRIPT_HELPER) }),
    },
    {
      ending: "left the entry untouched",
      row: collectedRow({ repetition: 2 }),
    },
    {
      ending: "ran out of time",
      row: collectedRow({ repetition: 3, timedOut: true, signal: "SIGTERM", exitCode: -1, files: {} }),
    },
    {
      ending: "errored before finishing",
      row: collectedRow({ repetition: 4, agentError: "agent exited -1 after a partial run", exitCode: 1, files: {} }),
    },
    {
      ending: "changed a python entry",
      row: collectedRow({
        repetition: 5,
        caseId: PYTHON_CASE_ID,
        files: entryWithAnAddedHelper(PYTHON_CASE_ID, PYTHON_ENTRY_FILE, PYTHON_HELPER),
      }),
    },
  ];
}

function runHolding(sessions: Session[]): string {
  const session = sessionThatEditsOnTurnsTwoAndFourAndIsNudgedBothTimes();
  return writeRun(
    tempDir("record-every-ending-"),
    sessions.map(({ row }) => row),
    Object.fromEntries(sessions.map(({ row }) => [singleTaskSessionLogName(row.caseId, row.treatmentId, row.repetition), session])),
  );
}

function factsBySessionEnding(sessions: Session[], records: ReportRecord[]): Record<string, string[]> {
  return Object.fromEntries(
    sessions.map(({ ending, row }) => [ending, Object.keys(recordOfSession(records, row.repetition)).sort()]),
  );
}

function everyEndingCarriesEveryFact(sessions: Session[]): Record<string, string[]> {
  return Object.fromEntries(sessions.map(({ ending }) => [ending, [...FACTS_THE_REPORT_NEEDS].sort()]));
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

test("every session gets a record carrying the facts the report needs, however the session ended", async () => {
  const sessions = sessionsCoveringEveryEnding();

  const records = await scoreSingleTaskRun(runHolding(sessions));

  assert.deepEqual(factsBySessionEnding(sessions, records), everyEndingCarriesEveryFact(sessions));
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
