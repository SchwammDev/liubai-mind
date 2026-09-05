import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RULE } from "../contract.ts";
import type { RuleName } from "../contract.ts";
import { buildTranscriptView, nudgeFiringsIn, toolCallCountsIn, firstEditTurnIn, retryCountIn, reasoningIsPresentIn } from "./session-log.ts";
import {
  assistantMessage,
  assistantSaid,
  assistantThought,
  nudgeFired,
  sessionLog,
  toolCall,
  toolCallResult,
  turnStart,
  userSaid,
} from "./run-doubles.ts";

const COMMITTED_RUN_TRANSCRIPTS_DIR = join(import.meta.dirname, "runs", "numberless-prompt-v2-hard-flash", "transcripts");
const GRID_ACCUMULATE_PROMPT_SESSION = "py-grid-accumulate.cc-delta-prompt.1.jsonl";
const GRID_ACCUMULATE_SESSION_WITH_A_MIDWAY_RATE_LIMIT_ERROR = "py-grid-accumulate.cc-delta-numberless-prompt.8.jsonl";

function realSessionLog(filename: string): string {
  return readFileSync(join(COMMITTED_RUN_TRANSCRIPTS_DIR, filename), "utf8");
}

function assistantMessageEndingWith(stopReason: string): string {
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason } });
}

function expectedEmptyFirings(): Record<RuleName, { count: number; turns: number[] }> {
  const entries: [RuleName, { count: number; turns: number[] }][] = Object.values(RULE).map((rule) => [rule, { count: 0, turns: [] }]);
  return Object.fromEntries(entries) as Record<RuleName, { count: number; turns: number[] }>;
}

function factsExtractedFrom(log: string): {
  nudges: Record<RuleName, { count: number; turns: number[] }>;
  toolCalls: Record<string, number>;
  firstEditTurn: number | null;
  retries: number;
  reasoningPresent: boolean;
} {
  return {
    nudges: nudgeFiringsIn(log),
    toolCalls: toolCallCountsIn(log),
    firstEditTurn: firstEditTurnIn(log),
    retries: retryCountIn(log),
    reasoningPresent: reasoningIsPresentIn(log),
  };
}

test("every rule name is present in the firings even when none of them fired", () => {
  const firings = nudgeFiringsIn("");

  assert.deepEqual(Object.keys(firings).sort(), Object.values(RULE).sort());
});

test("a rule that never fires has zero count and no turns recorded", () => {
  const log = sessionLog([turnStart(), toolCall("bash")]);

  const firings = nudgeFiringsIn(log);

  assert.deepEqual(firings[RULE.cc], { count: 0, turns: [] });
});

test("a rule firing twice on the same turn repeats that turn number in its list", () => {
  const log = sessionLog([turnStart(), nudgeFired(RULE.cc), nudgeFired(RULE.cc)]);

  const firings = nudgeFiringsIn(log);

  assert.deepEqual(firings[RULE.cc], { count: 2, turns: [1, 1] });
});

test("nudges across turns are recorded in ascending turn order", () => {
  const log = sessionLog([
    turnStart(), nudgeFired(RULE.ccDelta),
    turnStart(), toolCall("read"),
    turnStart(), nudgeFired(RULE.ccDelta),
  ]);

  const firings = nudgeFiringsIn(log);

  assert.deepEqual(firings[RULE.ccDelta], { count: 2, turns: [1, 3] });
});

test("each tool_execution_start is counted under its tool name", () => {
  const log = sessionLog([turnStart(), toolCall("bash"), toolCall("read"), toolCall("bash")]);

  const counts = toolCallCountsIn(log);

  assert.deepEqual(counts, { bash: 2, read: 1 });
});

test("a tool that never runs is absent from the counts", () => {
  const log = sessionLog([turnStart(), toolCall("bash")]);

  const counts = toolCallCountsIn(log);

  assert.equal("edit" in counts, false);
});

test("the first edit call names the turn it happened on", () => {
  const log = sessionLog([turnStart(), toolCall("read"), turnStart(), toolCall("edit")]);

  assert.equal(firstEditTurnIn(log), 2);
});

test("a write call counts as the first edit just like an edit call", () => {
  const log = sessionLog([turnStart(), toolCall("write")]);

  assert.equal(firstEditTurnIn(log), 1);
});

test("a bash command that rewrites a file does not count as an edit", () => {
  const log = sessionLog([turnStart(), toolCall("bash")]);

  assert.equal(firstEditTurnIn(log), null);
});

test("a session with no edit or write call has no first edit turn", () => {
  const log = sessionLog([turnStart(), toolCall("read"), turnStart(), toolCall("bash")]);

  assert.equal(firstEditTurnIn(log), null);
});

test("an assistant message that errors and is followed by another assistant message counts as a retry", () => {
  const log = sessionLog([turnStart(), assistantMessageEndingWith("error"), assistantMessageEndingWith("stop")]);

  assert.equal(retryCountIn(log), 1);
});

test("an assistant message that errors on the final turn is not counted as a retry", () => {
  const log = sessionLog([turnStart(), assistantMessageEndingWith("stop"), assistantMessageEndingWith("error")]);

  assert.equal(retryCountIn(log), 0);
});

test("two errors each followed by another assistant message count as two retries", () => {
  const log = sessionLog([
    turnStart(),
    assistantMessageEndingWith("error"),
    assistantMessageEndingWith("error"),
    assistantMessageEndingWith("stop"),
  ]);

  assert.equal(retryCountIn(log), 2);
});

test("a thinking content part marks reasoning as present", () => {
  const log = sessionLog([turnStart(), assistantThought("weighing the two shapes")]);

  assert.equal(reasoningIsPresentIn(log), true);
});

test("a session with no thinking content part has no reasoning", () => {
  const log = sessionLog([turnStart(), assistantSaid("done")]);

  assert.equal(reasoningIsPresentIn(log), false);
});

test("blank lines and invalid json lines are skipped without throwing", () => {
  const log = ["", "not json", toolCall("bash")].join("\n") + "\n";

  const counts = toolCallCountsIn(log);

  assert.deepEqual(counts, { bash: 1 });
});

test("an empty log gives zero counts, empty turn arrays, a null first edit turn, zero retries and no reasoning", () => {
  assert.deepEqual(factsExtractedFrom(""), {
    nudges: expectedEmptyFirings(),
    toolCalls: {},
    firstEditTurn: null,
    retries: 0,
    reasoningPresent: false,
  });
});

test("a real session that explores before editing is tallied by tool, first-edited on turn twelve, unretried, unreasoned, and unnudged because its treatment delivered its message in the task text rather than the live hook", () => {
  const log = realSessionLog(GRID_ACCUMULATE_PROMPT_SESSION);

  assert.deepEqual(factsExtractedFrom(log), {
    nudges: expectedEmptyFirings(),
    toolCalls: { bash: 21, read: 3, write: 3, edit: 4 },
    firstEditTurn: 12,
    retries: 0,
    reasoningPresent: false,
  });
});

test("a real session that hits a mid-session rate-limit error and goes on to finish normally counts one retry", () => {
  const log = realSessionLog(GRID_ACCUMULATE_SESSION_WITH_A_MIDWAY_RATE_LIMIT_ERROR);

  assert.equal(retryCountIn(log), 1);
});

test("each turn's transcript view lists the tool calls it made, in call order", () => {
  const log = sessionLog([turnStart(), toolCall("read"), toolCall("bash")]);

  const transcript = buildTranscriptView(log);

  assert.deepEqual(transcript.turns[0]!.toolCalls, ["read", "bash"]);
});

test("a nudge fired during a turn's tool call is recorded on that turn, not the next one", () => {
  const log = sessionLog([turnStart(), toolCall("edit"), nudgeFired(RULE.ccDelta), turnStart(), toolCall("bash")]);

  const transcript = buildTranscriptView(log);

  assert.deepEqual(
    transcript.turns.map((turn) => turn.nudges),
    [[RULE.ccDelta], []],
  );
});

test("the user's opening message and the assistant's final text land on their own turn", () => {
  const log = sessionLog([turnStart(), userSaid("fix the bug"), assistantMessage({ text: "done", stopReason: "stop" })]);

  const transcript = buildTranscriptView(log);

  assert.deepEqual(
    { userText: transcript.turns[0]!.userText, assistantText: transcript.turns[0]!.assistantText, isFinal: transcript.turns[0]!.isFinal },
    { userText: "fix the bug", assistantText: "done", isFinal: true },
  );
});

test("per-turn input and output tokens come from that turn's own assistant message", () => {
  const log = sessionLog([turnStart(), assistantMessage({ text: "looking", stopReason: "toolUse", tokensIn: 120, tokensOut: 40 })]);

  const transcript = buildTranscriptView(log);

  assert.deepEqual(
    { tokensIn: transcript.turns[0]!.tokensIn, tokensOut: transcript.turns[0]!.tokensOut },
    { tokensIn: 120, tokensOut: 40 },
  );
});

test("an assistant message that errors marks its own turn as a retry failure", () => {
  const log = sessionLog([turnStart(), assistantMessage({ stopReason: "error" })]);

  const transcript = buildTranscriptView(log);

  assert.equal(transcript.turns[0]!.isRetryFailure, true);
});

test("the transcript view carries reasoning-present the same way the aggregate fact does", () => {
  const log = sessionLog([turnStart(), assistantThought("weighing the two shapes")]);

  const transcript = buildTranscriptView(log);

  assert.equal(transcript.reasoningPresent, true);
});

test("a tool result far longer than the display cap is truncated, but its true line count survives", () => {
  const longResult = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const log = sessionLog([turnStart(), toolCall("bash"), toolCallResult("bash", longResult)]);

  const transcript = buildTranscriptView(log);
  const call = transcript.turns[0]!.toolCallDetails[0]!;

  assert.deepEqual(
    { truncated: call.resultTruncated, shorterThanOriginal: call.result!.length < longResult.length, trueLineCount: call.resultLineCount },
    { truncated: true, shorterThanOriginal: true, trueLineCount: 500 },
  );
});

test("an edit call's diff is captured for display", () => {
  const log = sessionLog([turnStart(), toolCall("edit"), toolCallResult("edit", "Successfully replaced 1 block(s).", { diff: "-old\n+new" })]);

  const transcript = buildTranscriptView(log);

  assert.equal(transcript.turns[0]!.toolCallDetails[0]!.diff, "-old\n+new");
});

test("a failing tool call is marked as an error on its own call detail", () => {
  const log = sessionLog([turnStart(), toolCall("bash"), toolCallResult("bash", "not found", { isError: true })]);

  const transcript = buildTranscriptView(log);

  assert.equal(transcript.turns[0]!.toolCallDetails[0]!.isError, true);
});

test("an empty log yields a transcript view with no turns and no reasoning present", () => {
  assert.deepEqual(buildTranscriptView(""), { turns: [], reasoningPresent: false });
});

test("a real session's transcript view accounts for every tool call the tallies already know about", () => {
  const log = realSessionLog(GRID_ACCUMULATE_PROMPT_SESSION);

  const transcript = buildTranscriptView(log);
  const totalToolCallsInTranscript = transcript.turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0);
  const totalToolCallsTallied = Object.values(toolCallCountsIn(log)).reduce((a, b) => a + b, 0);

  assert.equal(totalToolCallsInTranscript, totalToolCallsTallied);
});
