import { test } from "node:test";
import assert from "node:assert/strict";

import { CLARIFY_TAG, getResultOutput, type SingleResult } from "./child.ts";
import { ChildSession, type UiForwarder } from "./bridge.ts";
import { FakeTransport } from "./testing.ts";
import {
  ClarifyStore,
  completeClarify,
  onClarifyTimeout,
  wireAbortDuringSuspend,
  answerClarify,
  gateChildReport,
  singleSpawnResult,
  answerToolResult,
  spawnBlockedResult,
  type SuspendedState,
} from "./clarify.ts";

const makeResult = (overrides: Partial<SingleResult> = {}): SingleResult => ({
  task: "do it",
  exitCode: 0,
  messages: [],
  stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  ...overrides,
});

const assistantMsg = (text: string) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "m",
    stopReason: "end",
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
  },
});

class FakeForwarder implements UiForwarder {
  hasUI = true;
  confirm() { return Promise.resolve(true); }
  select() { return Promise.resolve(undefined); }
  input() { return Promise.resolve(undefined); }
  editor() { return Promise.resolve(undefined); }
  notify() {}
}

const makeState = (overrides: Partial<SuspendedState> = {}): SuspendedState => {
  const transport = overrides.transport ?? new FakeTransport();
  const result = overrides.result ?? makeResult();
  const session = overrides.session ?? new ChildSession(transport, new FakeForwarder(), result);
  return {
    clarifyId: "q1",
    question: "which file?",
    transport,
    session,
    result,
    budget: { delivered: 0 },
    onUpdate: undefined,
    mode: "single",
    timer: null,
    finished: false,
    ...overrides,
  };
};

const assistantText = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }] as any;

const PREAMBLE_TEXT = "preamble before the clarify tool call";

const suspended = (extra: Partial<SuspendedState> = {}) => {
  const store = new ClarifyStore();
  const t = new FakeTransport();
  const state = makeState({ ...extra, transport: t });
  store.setSuspended(state);
  return { store, t, state };
};

const emitSettled = (t: FakeTransport) => t.emitLine(JSON.stringify({ type: "agent_settled" }));
const emitReport = (t: FakeTransport, text: string) => t.emitLine(JSON.stringify(assistantMsg(text)));
const emitReask = (t: FakeTransport, id: string, question: string) =>
  t.emitLine(JSON.stringify({ type: "extension_ui_request", id, method: "input", title: CLARIFY_TAG + question }));

const abortDuringSuspend = (store: ClarifyStore, state: SuspendedState, ac: AbortController) => {
  wireAbortDuringSuspend(store, state, ac.signal);
  ac.abort();
};

const stashLateReportViaTimeout = async (store: ClarifyStore, t: FakeTransport, state: SuspendedState, text: string) => {
  const timeoutP = onClarifyTimeout(store, state);
  emitReport(t, text);
  emitSettled(t);
  await timeoutP;
};

const cleanupTimer = (store: ClarifyStore, state: SuspendedState) => {
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  store.reset();
};

const assertWrote = (t: FakeTransport, id: string, value: string) =>
  assert.deepEqual(t.lastWrite(), { type: "extension_ui_response", id, value });
const assertKilled = (t: FakeTransport) => assert.equal(t.killed, true);
const assertDone = (outcome: any) => assert.equal(outcome.kind, "done");
const assertSlotCleared = (store: ClarifyStore) => assert.equal(store.getSuspended(), null);
const assertLateReport = (store: ClarifyStore, text: string | null) => assert.equal(store.getLateReport(), text);

const assertEarlyExitFlagged = (state: SuspendedState, code: number) => {
  assert.equal(state.result.settled, false);
  assert.equal(state.result.errorMessage, `child exited (code ${code}) before completing its turn`);
};

const assertReSuspended = (outcome: any, state: SuspendedState, t: FakeTransport, id: string, question: string) => {
  assert.equal(outcome.kind, "suspended");
  if (outcome.kind === "suspended") assert.deepEqual(outcome.clarify, { id, question });
  assert.equal(state.clarifyId, id);
  assert.equal(state.question, question);
  assert.equal(t.killed, false);
};

const assertStillSuspended = (store: ClarifyStore, state: SuspendedState, t: FakeTransport, id: string, question: string) => {
  assert.equal(store.getSuspended(), state);
  assert.equal(state.clarifyId, id);
  assert.equal(state.question, question);
  assert.equal(t.killed, false);
};

const assertLateReportStashed = (store: ClarifyStore, t: FakeTransport, text: string) => {
  assert.equal(store.getSuspended(), null);
  assert.equal(store.getLateReport(), text);
  assert.equal(t.killed, true);
};

const assertAbortStashedLateReport = (store: ClarifyStore, t: FakeTransport) => {
  assert.equal(t.killed, true);
  assert.equal(store.getSuspended(), null);
  assert.ok(store.getLateReport());
};

const assertAbortLeftLateReport = (store: ClarifyStore) => {
  assert.equal(store.getSuspended(), null);
  assert.ok(store.getLateReport());
};

const assertAnsweredReport = (outcome: any, report: string) => {
  assert.equal(outcome.kind, "done");
  if (outcome.kind === "done") {
    assert.equal(outcome.report, report);
    assert.equal(outcome.failed, false);
  }
};

const assertDeliveredAndClosed = (store: ClarifyStore, t: FakeTransport, state: SuspendedState) => {
  assert.equal(state.budget.delivered, 1);
  assert.equal(store.getSuspended(), null);
  assert.equal(t.killed, true);
};

const assertReAsked = (outcome: any, store: ClarifyStore, state: SuspendedState, t: FakeTransport, id: string, question: string) => {
  assert.equal(outcome.kind, "ask");
  if (outcome.kind === "ask") assert.equal(outcome.question, question);
  assert.equal(state.budget.delivered, 1);
  assert.equal(store.getSuspended(), state);
  assert.equal(state.clarifyId, id);
  assert.equal(t.killed, false);
};

const assertNone = (outcome: any, text: string) => {
  assert.equal(outcome.kind, "none");
  if (outcome.kind === "none") assert.equal(outcome.text, text);
};

test("completeClarify writes the response and returns done after the child settles", async () => {
  const { t, state } = suspended();
  const outcomeP = completeClarify(state, "use file A");
  assertWrote(t, "q1", "use file A");
  emitSettled(t);

  const outcome = await outcomeP;
  assertDone(outcome);
  assertKilled(t);
});

test("completeClarify returns suspended when the child asks again after the answer", async () => {
  const { t, state } = suspended();
  const outcomeP = completeClarify(state, "ans1");
  emitReask(t, "q2", "second?");

  const outcome = await outcomeP;
  assertReSuspended(outcome, state, t, "q2", "second?");
});

test("completeClarify flags a clean early exit on resume instead of surfacing the preamble as the report", async () => {
  const { t, state } = suspended({ result: makeResult({ messages: assistantText(PREAMBLE_TEXT) }) });
  const outcomeP = completeClarify(state, "use file A");
  assertWrote(t, "q1", "use file A");
  t.emitClose(0);
  const outcome = await outcomeP;
  assertDone(outcome);
  assertEarlyExitFlagged(state, 0);
  assert.notEqual(getResultOutput(state.result), PREAMBLE_TEXT);
});

test("onClarifyTimeout auto-denies, settles the child, stashes a late report, and clears the slot", async () => {
  const { store, t, state } = suspended();
  const timeoutP = onClarifyTimeout(store, state);
  assertWrote(t, "q1", "proceed with best judgment");
  emitReport(t, "late report");
  emitSettled(t);
  await timeoutP;
  assertLateReportStashed(store, t, "late report");
});

test("onClarifyTimeout re-suspends when the child asks again after the auto-deny", async () => {
  const { store, t, state } = suspended();
  const timeoutP = onClarifyTimeout(store, state);
  emitReask(t, "q2", "again?");
  await timeoutP;

  assertStillSuspended(store, state, t, "q2", "again?");
  cleanupTimer(store, state);
});

test("wireAbortDuringSuspend kills the child and stashes a late report on abort", () => {
  const { store, t, state } = suspended();
  const ac = new AbortController();

  abortDuringSuspend(store, state, ac);

  assertAbortStashedLateReport(store, t);
});

test("answerClarify with nothing pending returns the no-question message", async () => {
  const store = new ClarifyStore();

  const outcome = await answerClarify(store, "x");

  assert.equal(outcome.kind, "none");
  if (outcome.kind === "none") assert.equal(outcome.text, "No child is asking a question.");
});

test("answerClarify writes the response and returns the child's final report", async () => {
  const { store, t, state } = suspended();
  const answerP = answerClarify(store, "use file A");
  assertWrote(t, "q1", "use file A");
  emitReport(t, "done: file A");
  emitSettled(t);
  const outcome = await answerP;
  assertAnsweredReport(outcome, "done: file A");
  assertDeliveredAndClosed(store, t, state);
});

test("answerClarify returns ask when the child asks again and keeps the slot suspended", async () => {
  const { store, t, state } = suspended();
  const answerP = answerClarify(store, "ans1");
  emitReask(t, "q2", "second?");

  const outcome = await answerP;
  assertReAsked(outcome, store, state, t, "q2", "second?");
  cleanupTimer(store, state);
});

test("answerClarify returns the late report after a timeout cleared the slot", async () => {
  const { store, t, state } = suspended();
  await stashLateReportViaTimeout(store, t, state, "late report");
  assertSlotCleared(store);
  assertLateReport(store, "late report");

  const outcome = await answerClarify(store, "anything");
  assertNone(outcome, "late report");
  assertLateReport(store, null);
});

test("answerClarify returns the abort late report after abort cleared the slot", async () => {
  const { store, t, state } = suspended();
  const ac = new AbortController();
  emitReport(t, "partial work");
  abortDuringSuspend(store, state, ac);
  assertAbortLeftLateReport(store);

  const outcome = await answerClarify(store, "x");
  assertNone(outcome, "partial work");
});

test("gateChildReport sets finalReport to the last assistant text under the cap", async () => {
  const t = new FakeTransport();
  const result = makeResult();
  const session = new ChildSession(t, new FakeForwarder(), result);
  t.emitLine(JSON.stringify(assistantMsg("short report")));

  await gateChildReport(result, session, undefined);

  assert.equal(result.finalReport, "short report");
});

test("spawnBlockedResult flags an error directing the model to answer first", () => {
  const out = spawnBlockedResult();

  assert.equal((out.content[0] as any).text, "A spawned child is awaiting an answer. Call `answer(text=…)` before spawning another.");
  assert.equal((out as any).isError, true);
});

test("singleSpawnResult surfaces a suspend as 'Child asks' with the partial result and no error", () => {
  const result = makeResult();
  const out = singleSpawnResult({ kind: "suspended", clarify: { id: "q1", question: "which file?" }, result });

  const text = (out.content[0] as any).text;
  assert.equal(text, "Child asks: which file?\n\nCall `answer(text=…)` to reply.");
  assert.deepEqual((out.details as any), { mode: "single", results: [result] });
  assert.equal((out as any).isError, undefined);
});

test("singleSpawnResult returns the final report for a settled success", () => {
  const result = makeResult({ settled: true, finalReport: "done: file A" });
  const out = singleSpawnResult({ kind: "done", result });

  assert.equal((out.content[0] as any).text, "done: file A");
  assert.equal((out as any).isError, undefined);
});

test("singleSpawnResult falls back to the last assistant text when no finalReport", () => {
  const result = makeResult({ settled: true, messages: assistantText("live output") });
  const out = singleSpawnResult({ kind: "done", result });

  assert.equal((out.content[0] as any).text, "live output");
});

test("singleSpawnResult flags a failed child with its stop reason and output", () => {
  const result = makeResult({ exitCode: 1, stopReason: "error", errorMessage: "provider timed out" });
  const out = singleSpawnResult({ kind: "done", result });

  assert.equal((out.content[0] as any).text, "Child error: provider timed out");
  assert.equal((out as any).isError, true);
});

test("answerToolResult surfaces a re-ask as 'Child asks' with the in-progress result", () => {
  const result = makeResult();
  const out = answerToolResult({ kind: "ask", question: "second?", result });

  assert.equal((out.content[0] as any).text, "Child asks: second?\n\nCall `answer(text=…)` to reply.");
  assert.deepEqual((out.details as any), { mode: "single", results: [result] });
  assert.equal((out as any).isError, undefined);
});

test("answerToolResult returns the report and flags a failed completion", () => {
  const result = makeResult({ exitCode: 1 });
  const out = answerToolResult({ kind: "done", report: "it broke", result, failed: true });

  assert.equal((out.content[0] as any).text, "it broke");
  assert.equal((out as any).isError, true);
});

test("answerToolResult returns a success report with isError false", () => {
  const result = makeResult({ settled: true });
  const out = answerToolResult({ kind: "done", report: "all good", result, failed: false });

  assert.equal((out.content[0] as any).text, "all good");
  assert.equal((out as any).isError, false);
});

test("answerToolResult returns the no-question text with empty results when nothing is pending", () => {
  const out = answerToolResult({ kind: "none", text: "No child is asking a question." });

  assert.equal((out.content[0] as any).text, "No child is asking a question.");
  assert.deepEqual((out.details as any), { mode: "single", results: [] });
});
