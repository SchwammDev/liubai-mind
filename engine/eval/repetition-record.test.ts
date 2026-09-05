import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRepetitionRecord } from "./repetition-record.ts";
import type { RepetitionRecord, RepetitionRecordInput } from "./repetition-record.ts";
import type { RawRow } from "./eval-contract.ts";
import { RULE } from "../contract.ts";
import {
  nudgeFired,
  nudgeCounts,
  sessionLog,
  toolCall,
  turnStart,
  assistantSaid,
  assistantThought,
} from "./run-doubles.ts";

const CASE_ID = "ts-flag-parser";
const TREATMENT_ID = "rails-default";
const REPETITION = 1;

const FACTS_THE_REPORT_NEEDS: (keyof RepetitionRecord)[] = [
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

function row(over: Partial<RawRow> = {}): RawRow {
  return {
    caseId: CASE_ID,
    treatmentId: TREATMENT_ID,
    repetition: REPETITION,
    provenance: {
      treatmentId: TREATMENT_ID,
      phrasingPackHash: null,
      liubaiSha: "abc1234",
      model: "test-model",
      collectedAt: "2026-09-05T00:00:00.000Z",
    },
    files: {},
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    nudges: nudgeCounts({}),
    ...over,
  };
}

function input(over: Partial<RepetitionRecordInput> = {}): RepetitionRecordInput {
  return {
    row: row(),
    startsFrom: { kind: "original-source" },
    transcriptPath: null,
    sessionLog: undefined,
    verdict: "genuine-fix",
    gamedReason: null,
    failedBehaviorChecks: [],
    decisionPointsBefore: 4,
    decisionPointsAfter: 2,
    entrySymbolComplexityBefore: 4,
    entrySymbolComplexityAfter: 2,
    functionsBefore: 1,
    functionsAfter: 1,
    linesAdded: 3,
    linesRemoved: 1,
    entryUnchanged: false,
    filesCreated: [],
    contaminated: false,
    consultedRail: false,
    ...over,
  };
}

function sessionThatEditsOnceAndFiresOneCcDeltaNudge(): string {
  return sessionLog([turnStart(), toolCall("read"), turnStart(), toolCall("edit"), nudgeFired(RULE.ccDelta)]);
}

test("a timed-out row is recorded as ending in timed-out even though its entry file was never touched", () => {
  const record = buildRepetitionRecord(input({ row: row({ timedOut: true }), entryUnchanged: true }));

  assert.equal(record.ending, "timed-out");
});

test("an agent-errored row is recorded as ending in errored ahead of an unchanged entry file", () => {
  const record = buildRepetitionRecord(input({ row: row({ agentError: "boom" }), entryUnchanged: true }));

  assert.equal(record.ending, "errored");
});

test("a row whose entry file never changed is recorded as ending in no-edit", () => {
  const record = buildRepetitionRecord(input({ entryUnchanged: true }));

  assert.equal(record.ending, "no-edit");
});

test("a row whose entry file changed and neither timed out nor errored is recorded as ending in final-text", () => {
  const record = buildRepetitionRecord(input({ entryUnchanged: false }));

  assert.equal(record.ending, "final-text");
});

test("a session with no log carries null for every fact that only a log can answer", () => {
  const record = buildRepetitionRecord(input({ transcriptPath: null, sessionLog: undefined }));

  assert.deepEqual(
    { retries: record.retries, nudges: record.nudges, toolCalls: record.toolCalls, firstEditTurn: record.firstEditTurn },
    { retries: null, nudges: null, toolCalls: null, firstEditTurn: null },
  );
});

function logFactsOf(record: RepetitionRecord): unknown {
  return { retries: record.retries, ccDeltaNudges: record.nudges![RULE.ccDelta].count, editToolCalls: record.toolCalls!.edit, firstEditTurn: record.firstEditTurn };
}

test("a session's log supplies the retry count, nudge firings, tool call counts and first edit turn", () => {
  const log = sessionThatEditsOnceAndFiresOneCcDeltaNudge();

  const record = buildRepetitionRecord(input({ transcriptPath: "transcripts/x.jsonl", sessionLog: log }));

  assert.deepEqual(logFactsOf(record), { retries: 0, ccDeltaNudges: 1, editToolCalls: 1, firstEditTurn: 2 });
});

test("reasoning is reported as absent when the row predates the reasoning field and no log is present", () => {
  const record = buildRepetitionRecord(input({ row: row(), sessionLog: undefined }));

  assert.deepEqual(record.reasoning, { requested: null, present: false });
});

test("reasoning is reported as requested but absent when the agent's log carries no thinking content", () => {
  const askedForReasoning = row({ provenance: { ...row().provenance, reasoning: "high" } });
  const log = sessionLog([turnStart(), assistantSaid("done")]);

  const record = buildRepetitionRecord(input({ row: askedForReasoning, sessionLog: log }));

  assert.deepEqual(record.reasoning, { requested: "high", present: false });
});

test("reasoning is reported as requested and present when the agent's log carries thinking content", () => {
  const askedForReasoning = row({ provenance: { ...row().provenance, reasoning: "high" } });
  const log = sessionLog([turnStart(), assistantThought("weighing options"), assistantSaid("done")]);

  const record = buildRepetitionRecord(input({ row: askedForReasoning, sessionLog: log }));

  assert.deepEqual(record.reasoning, { requested: "high", present: true });
});

test("a record carries every fact the report needs and none it does not", () => {
  const record = buildRepetitionRecord(input());

  assert.deepEqual(Object.keys(record).sort(), [...FACTS_THE_REPORT_NEEDS].sort());
});
