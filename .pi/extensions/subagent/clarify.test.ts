import { test } from "node:test";
import assert from "node:assert/strict";

import { CLARIFY_TAG, type SingleResult } from "./child.ts";
import { ChildSession, type ChildTransport, type UiForwarder } from "./bridge.ts";
import {
  completeClarify,
  onClarifyTimeout,
  wireAbortDuringSuspend,
  answerClarify,
  gateChildReport,
  singleSpawnResult,
  answerToolResult,
  spawnBlockedResult,
  type SuspendedState,
  getSuspended,
  __getLateReport,
  __setSuspended,
  __resetClarifyState,
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

class FakeTransport implements ChildTransport {
  writes: string[] = [];
  private lineCbs: Array<(line: string) => void> = [];
  private closeCbs: Array<(code: number | null) => void> = [];
  killed = false;

  write(line: string) { this.writes.push(line); }
  onLine(cb: (line: string) => void) { this.lineCbs.push(cb); }
  onClose(cb: (code: number | null) => void) { this.closeCbs.push(cb); }
  kill() { this.killed = true; }
  emitLine(line: string) { for (const cb of this.lineCbs) cb(line); }
  emitClose(code: number | null) { for (const cb of this.closeCbs) cb(code); }
  writtenJson() { return this.writes.map((w) => JSON.parse(w)); }
  lastWrite() { return this.writes.length ? JSON.parse(this.writes[this.writes.length - 1]) : null; }
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

test("completeClarify writes the response and returns done after the child settles", async () => {
  __resetClarifyState();
  const t = new FakeTransport();
  const state = makeState({ transport: t });
  __setSuspended(state);

  const outcomeP = completeClarify(state, "use file A");
  assert.deepEqual(t.lastWrite(), { type: "extension_ui_response", id: "q1", value: "use file A" });
  t.emitLine(JSON.stringify({ type: "agent_settled" }));

  const outcome = await outcomeP;
  assert.equal(outcome.kind, "done");
  assert.equal(t.killed, true);
});

test("completeClarify returns suspended when the child asks again after the answer", async () => {
  __resetClarifyState();
  const t = new FakeTransport();
  const state = makeState({ transport: t });
  __setSuspended(state);

  const outcomeP = completeClarify(state, "ans1");
  t.emitLine(JSON.stringify({ type: "extension_ui_request", id: "q2", method: "input", title: CLARIFY_TAG + "second?" }));

  const outcome = await outcomeP;
  assert.equal(outcome.kind, "suspended");
  if (outcome.kind === "suspended") {
    assert.deepEqual(outcome.clarify, { id: "q2", question: "second?" });
  }
  assert.equal(state.clarifyId, "q2");
  assert.equal(state.question, "second?");
  assert.equal(t.killed, false);
});

test("onClarifyTimeout auto-denies, settles the child, stashes a late report, and clears the slot", async () => {
  __resetClarifyState();
  const t = new FakeTransport();
  const state = makeState({ transport: t });
  __setSuspended(state);

  const timeoutP = onClarifyTimeout(state);
  assert.deepEqual(t.lastWrite(), { type: "extension_ui_response", id: "q1", value: "proceed with best judgment" });
  t.emitLine(JSON.stringify(assistantMsg("late report")));
  t.emitLine(JSON.stringify({ type: "agent_settled" }));

  await timeoutP;
  assert.equal(getSuspended(), null);
  assert.equal(__getLateReport(), "late report");
  assert.equal(t.killed, true);
});

test("onClarifyTimeout re-suspends when the child asks again after the auto-deny", async () => {
  __resetClarifyState();
  const t = new FakeTransport();
  const state = makeState({ transport: t });
  __setSuspended(state);

  const timeoutP = onClarifyTimeout(state);
  t.emitLine(JSON.stringify({ type: "extension_ui_request", id: "q2", method: "input", title: CLARIFY_TAG + "again?" }));

  const r = await timeoutP;
  void r;
  assert.equal(getSuspended(), state);
  assert.equal(state.clarifyId, "q2");
  assert.equal(state.question, "again?");
  assert.equal(t.killed, false);
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  __resetClarifyState();
});

test("wireAbortDuringSuspend kills the child and stashes a late report on abort", () => {
  __resetClarifyState();
  const t = new FakeTransport();
  const ac = new AbortController();
  const state = makeState({ transport: t });
  __setSuspended(state);

  wireAbortDuringSuspend(state, ac.signal);
  ac.abort();

  assert.equal(t.killed, true);
  assert.equal(getSuspended(), null);
  assert.ok(__getLateReport());
});

test("answerClarify with nothing pending returns the no-question message", async () => {
  __resetClarifyState();

  const outcome = await answerClarify("x");

  assert.equal(outcome.kind, "none");
  if (outcome.kind === "none") assert.equal(outcome.text, "No child is asking a question.");
});

test("answerClarify writes the response and returns the child's final report", async () => {
  __resetClarifyState();
  const t = new FakeTransport();
  const state = makeState({ transport: t });
  __setSuspended(state);

  const answerP = answerClarify("use file A");
  assert.deepEqual(t.lastWrite(), { type: "extension_ui_response", id: "q1", value: "use file A" });
  t.emitLine(JSON.stringify(assistantMsg("done: file A")));
  t.emitLine(JSON.stringify({ type: "agent_settled" }));

  const outcome = await answerP;
  assert.equal(outcome.kind, "done");
  if (outcome.kind === "done") {
    assert.equal(outcome.report, "done: file A");
    assert.equal(outcome.failed, false);
  }
  assert.equal(state.budget.delivered, 1);
  assert.equal(getSuspended(), null);
  assert.equal(t.killed, true);
});

test("answerClarify returns ask when the child asks again and keeps the slot suspended", async () => {
  __resetClarifyState();
  const t = new FakeTransport();
  const state = makeState({ transport: t });
  __setSuspended(state);

  const answerP = answerClarify("ans1");
  t.emitLine(JSON.stringify({ type: "extension_ui_request", id: "q2", method: "input", title: CLARIFY_TAG + "second?" }));

  const outcome = await answerP;
  assert.equal(outcome.kind, "ask");
  if (outcome.kind === "ask") assert.equal(outcome.question, "second?");
  assert.equal(state.budget.delivered, 1);
  assert.equal(getSuspended(), state);
  assert.equal(state.clarifyId, "q2");
  assert.equal(t.killed, false);
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  __resetClarifyState();
});

test("answerClarify returns the late report after a timeout cleared the slot", async () => {
  __resetClarifyState();
  const t = new FakeTransport();
  const state = makeState({ transport: t });
  __setSuspended(state);

  const timeoutP = onClarifyTimeout(state);
  t.emitLine(JSON.stringify(assistantMsg("late report")));
  t.emitLine(JSON.stringify({ type: "agent_settled" }));
  await timeoutP;
  assert.equal(getSuspended(), null);
  assert.equal(__getLateReport(), "late report");

  const outcome = await answerClarify("anything");
  assert.equal(outcome.kind, "none");
  if (outcome.kind === "none") assert.equal(outcome.text, "late report");
  assert.equal(__getLateReport(), null);
});

test("answerClarify returns the abort late report after abort cleared the slot", async () => {
  __resetClarifyState();
  const t = new FakeTransport();
  const ac = new AbortController();
  const state = makeState({ transport: t });
  __setSuspended(state);

  t.emitLine(JSON.stringify(assistantMsg("partial work")));
  wireAbortDuringSuspend(state, ac.signal);
  ac.abort();
  assert.equal(getSuspended(), null);
  assert.ok(__getLateReport());

  const outcome = await answerClarify("x");
  assert.equal(outcome.kind, "none");
  if (outcome.kind === "none") assert.equal(outcome.text, "partial work");
});

test("gateChildReport sets finalReport to the last assistant text under the cap", async () => {
  const t = new FakeTransport();
  const result = makeResult();
  const session = new ChildSession(t, new FakeForwarder(), result);
  t.emitLine(JSON.stringify(assistantMsg("short report")));

  await gateChildReport(result, session, undefined);

  assert.equal(result.finalReport, "short report");
});

const assistantText = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }] as any;

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
