import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AskBridge,
  ChildSession,
  DialogGate,
  processRpcLine,
  type UiForwarder,
} from "./bridge.ts";
import { CLARIFY_TAG, MAX_CLARIFY, type SingleResult } from "./child.ts";
import { FakeTransport } from "./testing.ts";

const makeAcc = (): Pick<
  SingleResult,
  "messages" | "usage" | "stderr" | "model" | "stopReason" | "errorMessage"
> => ({
  messages: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  stderr: "",
});

const assistantMsg = (overrides: Record<string, unknown> = {}) =>
  ({
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    model: "m",
    stopReason: "end",
    usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.02 } },
    ...overrides,
  }) as any;

const flush = () => new Promise((r) => setImmediate(r));

class FakeForwarder implements UiForwarder {
  hasUI = true;
  confirmCalls: Array<{ title: string; message: string; opts: any }> = [];
  selectCalls: Array<{ title: string; options: string[]; opts: any }> = [];
  inputCalls: Array<{ title: string; placeholder: unknown; opts: any }> = [];
  editorCalls: Array<{ title: string; prefill: unknown }> = [];
  notifyCalls: Array<{ message: string; type: unknown }> = [];
  confirmResult = true;
  confirmShouldThrow = false;
  confirmPending = false;
  confirmManual = false;
  pendingConfirms: Array<(confirmed: boolean) => void> = [];
  selectResult: string | undefined = "chosen";
  inputResult: string | undefined = "typed";
  editorResult: string | undefined = "edited";

  confirm(title: string, message: string, opts?: any) {
    this.confirmCalls.push({ title, message, opts });
    if (this.confirmShouldThrow) return Promise.reject(new Error("nope"));
    if (this.confirmManual) {
      return new Promise<boolean>((resolve) => {
        this.pendingConfirms.push(resolve);
        opts?.signal?.addEventListener("abort", () => resolve(false), { once: true });
      });
    }
    if (this.confirmPending) {
      return new Promise<boolean>((resolve) => {
        opts?.signal?.addEventListener("abort", () => resolve(false), { once: true });
      });
    }
    return Promise.resolve(this.confirmResult);
  }
  select(title: string, options: string[], opts?: any) {
    this.selectCalls.push({ title, options, opts });
    return Promise.resolve(this.selectResult);
  }
  input(title: string, placeholder?: string, opts?: any) {
    this.inputCalls.push({ title, placeholder, opts });
    return Promise.resolve(this.inputResult);
  }
  editor(title: string, prefill?: string) {
    this.editorCalls.push({ title, prefill });
    return Promise.resolve(this.editorResult);
  }
  notify(message: string, type?: "info" | "warning" | "error") {
    this.notifyCalls.push({ message, type });
  }
}

class FakeWriter {
  lines: string[] = [];
  write(line: string) {
    this.lines.push(line);
  }
  json(i: number) {
    return JSON.parse(this.lines[i] ?? "");
  }
}

type ClarifyMode = "single" | "parallel";

const makeBridge = () => {
  const f = new FakeForwarder();
  const w = new FakeWriter();
  const bridge = new AskBridge(f, (l) => w.write(l));
  return { f, w, bridge };
};

const makeClarifyBridge = (mode: ClarifyMode, delivered: number) => {
  const f = new FakeForwarder();
  const w = new FakeWriter();
  const bridge = new AskBridge(f, (l) => w.write(l), undefined, undefined, mode, { delivered });
  return { f, w, bridge };
};

const detachedBridge = () => new AskBridge(new FakeForwarder(), () => {});

const uiRequest = (fields: Record<string, unknown>) =>
  ({ type: "extension_ui_request", ...fields }) as any;

const confirmRequest = (id: string, title = "T", message = "M", extra: Record<string, unknown> = {}) =>
  uiRequest({ id, method: "confirm", title, message, ...extra });

const clarifyInput = (id: string, question: string) =>
  uiRequest({ id, method: "input", title: CLARIFY_TAG + question });

const rpcLine = (message: object) => JSON.stringify(message);
const messageEnd = (message: unknown) => JSON.stringify({ type: "message_end", message });
const AGENT_END = JSON.stringify({ type: "agent_end", messages: [], willRetry: false });
const AGENT_SETTLED = JSON.stringify({ type: "agent_settled" });

const TOOL_RESULT_MSG = {
  role: "toolResult",
  content: [{ type: "toolResult", toolCallId: "t1", content: "ok" }],
};

const FIRE_AND_FORGET_REQUESTS = [
  uiRequest({ id: "x", method: "setStatus", statusKey: "k", statusText: "s" }),
  uiRequest({ id: "x", method: "setWidget", widgetKey: "k", widgetLines: ["l"] }),
  uiRequest({ id: "x", method: "setTitle", title: "t" }),
  uiRequest({ id: "x", method: "set_editor_text", text: "t" }),
];

const promptLine = (message: string) => ({ type: "prompt", message });
const valueResponse = (id: string, value: string) => ({ type: "extension_ui_response", id, value });
const cancelledResponse = (id: string) => ({ type: "extension_ui_response", id, cancelled: true });
const confirmedResponse = (id: string, confirmed: boolean) => ({ type: "extension_ui_response", id, confirmed });
const clarifyDeniedResponse = (id: string) => ({ type: "extension_ui_response", id, value: "proceed with best judgment" });
const suspendedOutcome = (id: string, question: string) => ({ settled: false, suspended: { clarifyId: id, question } });

const SETTLED = { settled: true, suspended: false, exitCode: 0, aborted: false };
const unsettled = (exitCode: number, aborted: boolean) => ({ settled: false, suspended: false, exitCode, aborted });

const makeSession = (t: FakeTransport, f: UiForwarder = new FakeForwarder()) =>
  new ChildSession(t, f, makeAcc());

const gatedSession = (t: FakeTransport, f: FakeForwarder, gate: DialogGate) =>
  new ChildSession(t, f, makeAcc(), undefined, undefined, gate);

const clarifySession = (t: FakeTransport) =>
  new ChildSession(t, new FakeForwarder(), makeAcc(), undefined, undefined, undefined, "single", { delivered: 0 });

const manualConfirmForwarder = () => {
  const f = new FakeForwarder();
  f.confirmManual = true;
  return f;
};

const pendingConfirmForwarder = () => {
  const f = new FakeForwarder();
  f.confirmPending = true;
  return f;
};

const answerSelect = async (bridge: AskBridge, f: FakeForwarder, id: string, result: string | undefined) => {
  f.selectResult = result;
  await bridge.handle(uiRequest({ id, method: "select", title: "T", options: ["a"] }));
};

const answerInput = async (bridge: AskBridge, f: FakeForwarder, id: string, result: string | undefined) => {
  f.inputResult = result;
  await bridge.handle(uiRequest({ id, method: "input", title: "T" }));
};

const answerEditor = async (bridge: AskBridge, f: FakeForwarder, id: string, result: string | undefined) => {
  f.editorResult = result;
  await bridge.handle(uiRequest({ id, method: "editor", title: "T" }));
};

const settle = (t: FakeTransport) => t.emitLine(AGENT_SETTLED);

const settleAnd = async (t: FakeTransport, p: Promise<unknown>) => {
  settle(t);
  await p;
};

const settleBoth = async (transports: FakeTransport[], promises: Promise<unknown>[]) => {
  for (const t of transports) settle(t);
  await Promise.all(promises);
};

const runPromptToSettle = async (session: ChildSession, t: FakeTransport, message: string) => {
  const p = session.sendPrompt(message);
  settle(t);
  await p;
};

const emitConfirmAsk = (t: FakeTransport, id: string, title: string, message: string) =>
  t.emitLine(rpcLine(confirmRequest(id, title, message)));

const answerNextConfirm = async (f: FakeForwarder, confirmed: boolean) => {
  f.pendingConfirms.shift()!(confirmed);
  await flush();
};

const uiResponses = (t: FakeTransport) =>
  t.writtenJson().filter((o) => o.type === "extension_ui_response");

const promptsWritten = (t: FakeTransport) =>
  t.writtenJson().filter((o) => o.type === "prompt");

const abortOf = (f: FakeForwarder): AbortSignal | undefined => f.confirmCalls[0]?.opts?.signal;

const waitForAbort = (signal: AbortSignal | undefined, defer = false) => {
  if (!signal) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => (defer ? setImmediate(resolve) : resolve()), { once: true });
  });
};

const openPendingConfirm = async (session: ChildSession, t: FakeTransport, f: FakeForwarder) => {
  const p = session.sendPrompt("task");
  emitConfirmAsk(t, "q1", "ok?", "proceed?");
  await flush();
  assert.equal(f.confirmCalls.length, 1);
  return { p };
};

const dismissPendingConfirmVia = async (f: FakeForwarder, action: () => void, defer = false) => {
  const dismissed = waitForAbort(abortOf(f), defer);
  action();
  await dismissed;
  await flush();
};

const startTwoGatedConfirmAsks = (gate: DialogGate, f: FakeForwarder) => {
  const t1 = new FakeTransport();
  const t2 = new FakeTransport();
  const p1 = gatedSession(t1, f, gate).sendPrompt("task1");
  const p2 = gatedSession(t2, f, gate).sendPrompt("task2");
  emitConfirmAsk(t1, "a1", "t1", "m1");
  emitConfirmAsk(t2, "a2", "t2", "m2");
  return { t1, t2, p1, p2 };
};

const openTwoAsksShowingFirst = async (f: FakeForwarder) => {
  const started = startTwoGatedConfirmAsks(new DialogGate(), f);
  await flush();
  assertConfirmCount(f, 1);
  return started;
};

const showOneDialogAtATime = async (f: FakeForwarder) => {
  await flush();
  assertConfirmCount(f, 1);
  await answerNextConfirm(f, true);
  assertConfirmCount(f, 2);
  await answerNextConfirm(f, false);
};

const startConfirmingChild = (id: string, confirmResult: boolean) => {
  const t = new FakeTransport();
  const f = new FakeForwarder();
  f.confirmResult = confirmResult;
  const p = new ChildSession(t, f, makeAcc()).sendPrompt("task-" + id);
  emitConfirmAsk(t, id, "title", "message");
  return { t, p };
};

const suspendOnClarify = async (session: ChildSession, t: FakeTransport, id: string, question: string) => {
  const p = session.sendPrompt("task");
  t.emitLine(rpcLine(clarifyInput(id, question)));
  const suspended = await p;
  assert.equal(suspended.suspended, true);
  return suspended;
};

const assertResponse = (w: FakeWriter, i: number, expected: unknown) => assert.deepEqual(w.json(i), expected);
const assertWroteNothing = (w: FakeWriter) => assert.equal(w.lines.length, 0);
const assertConfirmCount = (f: FakeForwarder, n: number) => assert.equal(f.confirmCalls.length, n);

const assertNoDialogsShown = (f: FakeForwarder) => {
  assert.equal(f.confirmCalls.length, 0);
  assert.equal(f.selectCalls.length, 0);
  assert.equal(f.inputCalls.length, 0);
  assert.equal(f.editorCalls.length, 0);
  assert.equal(f.notifyCalls.length, 0);
};

const assertAssistantAccumulated = (acc: ReturnType<typeof makeAcc>) => {
  assert.equal(acc.usage.input, 10);
  assert.equal(acc.usage.output, 5);
  assert.equal(acc.usage.cost, 0.02);
  assert.equal(acc.usage.contextTokens, 15);
  assert.equal(acc.usage.turns, 1);
  assert.equal(acc.model, "m");
  assert.equal(acc.stopReason, "end");
};

const assertNotYetResolved = async (p: Promise<unknown>) => {
  let resolved = false;
  p.then(() => {
    resolved = true;
  });
  await flush();
  assert.equal(resolved, false);
};

const assertConfirmForwardedAndAnswered = (f: FakeForwarder, t: FakeTransport, id: string, confirmed: boolean) => {
  assert.equal(f.confirmCalls.length, 1);
  assert.deepEqual(uiResponses(t), [confirmedResponse(id, confirmed)]);
};

const assertConfirmedResponses = (t: FakeTransport, id: string, confirmed: boolean) =>
  assert.deepEqual(uiResponses(t), [confirmedResponse(id, confirmed)]);

const assertAutoDenied = (w: FakeWriter, id: string) => {
  assert.equal(w.lines.length, 1);
  assert.deepEqual(w.json(0), clarifyDeniedResponse(id));
};

test("AskBridge forwards a confirm request and writes {id, confirmed}", async () => {
  const f = new FakeForwarder();
  const w = new FakeWriter();
  const bridge = new AskBridge(f, (l) => w.write(l));

  await bridge.handle({ type: "extension_ui_request", id: "c1", method: "confirm", title: "T", message: "M" });

  assert.deepEqual(f.confirmCalls, [{ title: "T", message: "M", opts: { signal: undefined, timeout: undefined } }]);
  assert.deepEqual(w.json(0), { type: "extension_ui_response", id: "c1", confirmed: true });
});

test("a child ask's timeout is forwarded to the parent dialog", async () => {
  const f = new FakeForwarder();
  const w = new FakeWriter();
  const bridge = new AskBridge(f, (l) => w.write(l));

  await bridge.handle({ type: "extension_ui_request", id: "c1", method: "confirm", title: "T", message: "M", timeout: 5000 });

  assert.equal(f.confirmCalls[0]?.opts.timeout, 5000);
});

test("AskBridge select writes {id, value} for a string and {id, cancelled} for undefined", async () => {
  const { f, w, bridge } = makeBridge();

  await answerSelect(bridge, f, "s1", "x");
  await answerSelect(bridge, f, "s2", undefined);

  assertResponse(w, 0, valueResponse("s1", "x"));
  assertResponse(w, 1, cancelledResponse("s2"));
});

test("AskBridge input writes {id, value} for a string and {id, cancelled} for undefined", async () => {
  const { f, w, bridge } = makeBridge();

  await answerInput(bridge, f, "i1", "typed");
  await answerInput(bridge, f, "i2", undefined);

  assertResponse(w, 0, valueResponse("i1", "typed"));
  assertResponse(w, 1, cancelledResponse("i2"));
});

test("AskBridge editor writes {id, value} for a string and {id, cancelled} for undefined", async () => {
  const { f, w, bridge } = makeBridge();

  await answerEditor(bridge, f, "e1", "edited");
  await answerEditor(bridge, f, "e2", undefined);

  assertResponse(w, 0, valueResponse("e1", "edited"));
  assertResponse(w, 1, cancelledResponse("e2"));
});

test("AskBridge notify forwards to the forwarder and writes nothing", async () => {
  const f = new FakeForwarder();
  const w = new FakeWriter();
  const bridge = new AskBridge(f, (l) => w.write(l));

  await bridge.handle({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi", notifyType: "warning" });

  assert.deepEqual(f.notifyCalls, [{ message: "hi", type: "warning" }]);
  assert.equal(w.lines.length, 0);
});

test("AskBridge fire-and-forget methods write nothing and do not call the forwarder", async () => {
  const { f, w, bridge } = makeBridge();

  for (const req of FIRE_AND_FORGET_REQUESTS) await bridge.handle(req);

  assertWroteNothing(w);
  assertNoDialogsShown(f);
});

test("AskBridge with hasUI false cancels a confirm immediately without calling the forwarder", async () => {
  const { f, w, bridge } = makeBridge();
  f.hasUI = false;

  await bridge.handle(confirmRequest("c1"));

  assert.equal(f.confirmCalls.length, 0);
  assertResponse(w, 0, cancelledResponse("c1"));
});

test("AskBridge writes {id, cancelled} when the forwarder rejects", async () => {
  const f = new FakeForwarder();
  f.confirmShouldThrow = true;
  const w = new FakeWriter();
  const bridge = new AskBridge(f, (l) => w.write(l));

  await bridge.handle({ type: "extension_ui_request", id: "c1", method: "confirm", title: "T", message: "M" });

  assert.deepEqual(w.json(0), { type: "extension_ui_response", id: "c1", cancelled: true });
});

test("processRpcLine pushes a message_end assistant message, sums usage, and stays unsettled", () => {
  const acc = makeAcc();
  const bridge = detachedBridge();

  const outcome = processRpcLine(messageEnd(assistantMsg()), acc, bridge);

  assert.equal(outcome.settled, false);
  assert.equal(acc.messages.length, 1);
  assertAssistantAccumulated(acc);
});

test("processRpcLine accumulates a toolResult message arriving via message_end", () => {
  const acc = makeAcc();
  const bridge = detachedBridge();

  const outcome = processRpcLine(messageEnd(TOOL_RESULT_MSG), acc, bridge);

  assert.equal(outcome.settled, false);
  assert.equal(acc.messages.length, 1);
  assert.equal(acc.usage.turns, 0);
});

test("processRpcLine does not resolve on agent_end with willRetry false", () => {
  const acc = makeAcc();
  const bridge = new AskBridge(new FakeForwarder(), () => {});

  const outcome = processRpcLine(JSON.stringify({ type: "agent_end", messages: [], willRetry: false }), acc, bridge);

  assert.equal(outcome.settled, false);
});

test("processRpcLine resolves only on agent_settled", () => {
  const acc = makeAcc();
  const bridge = new AskBridge(new FakeForwarder(), () => {});

  const outcome = processRpcLine(JSON.stringify({ type: "agent_settled" }), acc, bridge);

  assert.equal(outcome.settled, true);
});

test("processRpcLine treats a malformed JSON line as unsettled without accumulating", () => {
  const acc = makeAcc();

  const outcome = processRpcLine("{ not json", acc, detachedBridge());

  assert.equal(outcome.settled, false);
  assert.equal(acc.messages.length, 0);
});

test("processRpcLine counts an assistant turn even when the message carries no usage", () => {
  const acc = makeAcc();

  processRpcLine(messageEnd(assistantMsg({ usage: undefined })), acc, detachedBridge());

  assert.equal(acc.usage.turns, 1);
  assert.equal(acc.usage.input, 0);
});

test("processRpcLine defaults missing usage token fields to zero", () => {
  const acc = makeAcc();

  processRpcLine(messageEnd(assistantMsg({ usage: { output: 5 } })), acc, detachedBridge());

  assert.equal(acc.usage.input, 0);
  assert.equal(acc.usage.output, 5);
  assert.equal(acc.usage.contextTokens, 0);
});

test("processRpcLine latches the first assistant model and does not let later turns override it", () => {
  const acc = makeAcc();
  const bridge = detachedBridge();

  processRpcLine(messageEnd(assistantMsg({ model: "first" })), acc, bridge);
  processRpcLine(messageEnd(assistantMsg({ model: "second" })), acc, bridge);

  assert.equal(acc.model, "first");
});

test("processRpcLine records an assistant error message", () => {
  const acc = makeAcc();

  processRpcLine(messageEnd(assistantMsg({ errorMessage: "provider exploded" })), acc, detachedBridge());

  assert.equal(acc.errorMessage, "provider exploded");
});

test("processRpcLine routes an extension_ui_request to the bridge", async () => {
  const f = new FakeForwarder();
  const bridge = new AskBridge(f, () => {});
  const acc = makeAcc();

  processRpcLine(rpcLine(confirmRequest("q1", "t", "m")), acc, bridge);
  await flush();

  assert.equal(f.confirmCalls.length, 1);
});

test("ChildSession.sendPrompt writes the prompt and resolves only on agent_settled", async () => {
  const t = new FakeTransport();
  const p = makeSession(t).sendPrompt("do it");
  assert.deepEqual(t.writtenJson()[0], promptLine("do it"));

  t.emitLine(AGENT_END);
  await assertNotYetResolved(p);
  settle(t);
  assert.deepEqual(await p, SETTLED);
});

test("ChildSession.sendPrompt reuses the same transport across turns", async () => {
  const t = new FakeTransport();
  const session = makeSession(t);

  await runPromptToSettle(session, t, "first");
  await runPromptToSettle(session, t, "second");

  assert.deepEqual(promptsWritten(t), [promptLine("first"), promptLine("second")]);
});

test("ChildSession.sendPrompt resolves unsettled on premature close with the exit code", async () => {
  const t = new FakeTransport();
  const session = new ChildSession(t, new FakeForwarder(), makeAcc());

  const p = session.sendPrompt("hello");
  t.emitClose(7);

  assert.deepEqual(await p, { settled: false, suspended: false, exitCode: 7, aborted: false });
});

test("a confirm request mid-turn reaches the forwarder and writes the response back to the transport", async () => {
  const t = new FakeTransport();
  const f = new FakeForwarder();
  const p = makeSession(t, f).sendPrompt("task");
  emitConfirmAsk(t, "q1", "ok?", "proceed?");
  await flush();
  assertConfirmForwardedAndAnswered(f, t, "q1", true);
  await settleAnd(t, p);
});

test("a pending parent confirm is dismissed when the child dies mid-ask", async () => {
  const t = new FakeTransport();
  const f = pendingConfirmForwarder();

  const { p } = await openPendingConfirm(makeSession(t, f), t, f);
  await dismissPendingConfirmVia(f, () => t.emitClose(9));

  assert.deepEqual(await p, unsettled(9, false));
});

test("a pending parent confirm is dismissed on parent abort", async () => {
  const t = new FakeTransport();
  const f = pendingConfirmForwarder();
  const toolController = new AbortController();
  const session = new ChildSession(t, f, makeAcc(), undefined, toolController.signal);
  const { p } = await openPendingConfirm(session, t, f);

  await dismissPendingConfirmVia(f, () => { toolController.abort(); t.emitClose(1); }, true);
  assert.deepEqual(await p, unsettled(1, true));
});

test("concurrent asks from two children show one parent dialog at a time", async () => {
  const gate = new DialogGate();
  const f = manualConfirmForwarder();
  const { t1, t2, p1, p2 } = startTwoGatedConfirmAsks(gate, f);
  await showOneDialogAtATime(f);

  assertConfirmedResponses(t1, "a1", true);
  assertConfirmedResponses(t2, "a2", false);
  await settleBoth([t1, t2], [p1, p2]);
});

test("an ask queued behind another dialog is skipped when its child dies while waiting", async () => {
  const f = manualConfirmForwarder();
  const { t1, t2, p1, p2 } = await openTwoAsksShowingFirst(f);

  t2.emitClose(3);
  await answerNextConfirm(f, true);
  assertConfirmCount(f, 1);
  assert.deepEqual(await p2, unsettled(3, false));
  await settleAnd(t1, p1);
});

test("parallel children resolve asks independently by id with no cross-talk", async () => {
  const a = startConfirmingChild("a1", true);
  const b = startConfirmingChild("a2", false);
  await flush();
  await flush();

  assertConfirmedResponses(a.t, "a1", true);
  assertConfirmedResponses(b.t, "a2", false);
  await settleBoth([a.t, b.t], [a.p, b.p]);
});

test("interceptClarify returns the clarifyId and question for a tagged single-mode request under budget and writes no response", () => {
  const w = new FakeWriter();
  const bridge = new AskBridge(new FakeForwarder(), (l) => w.write(l), undefined, undefined, "single", { delivered: 0 });

  const out = bridge.interceptClarify({ type: "extension_ui_request", id: "q1", method: "input", title: CLARIFY_TAG + "which file?" });

  assert.deepEqual(out, { kind: "suspend", clarifyId: "q1", question: "which file?" });
  assert.equal(w.lines.length, 0);
});

test("interceptClarify auto-denies and returns denied in parallel mode", () => {
  const w = new FakeWriter();
  const bridge = new AskBridge(new FakeForwarder(), (l) => w.write(l), undefined, undefined, "parallel", { delivered: 0 });

  const out = bridge.interceptClarify({ type: "extension_ui_request", id: "q1", method: "input", title: CLARIFY_TAG + "which?" });

  assert.deepEqual(out, { kind: "denied" });
  assert.deepEqual(w.json(0), { type: "extension_ui_response", id: "q1", value: "proceed with best judgment" });
});

test("interceptClarify auto-denies and returns denied when the delivered budget is at the cap", () => {
  const w = new FakeWriter();
  const bridge = new AskBridge(new FakeForwarder(), (l) => w.write(l), undefined, undefined, "single", { delivered: MAX_CLARIFY });

  const out = bridge.interceptClarify({ type: "extension_ui_request", id: "q1", method: "input", title: CLARIFY_TAG + "which?" });

  assert.deepEqual(out, { kind: "denied" });
  assert.deepEqual(w.json(0), { type: "extension_ui_response", id: "q1", value: "proceed with best judgment" });
});

test("interceptClarify returns pass without writing for a non-input request", () => {
  const w = new FakeWriter();
  const bridge = new AskBridge(new FakeForwarder(), (l) => w.write(l), undefined, undefined, "single", { delivered: 0 });

  const out = bridge.interceptClarify({ type: "extension_ui_request", id: "q1", method: "confirm", title: CLARIFY_TAG + "which?", message: "which?" });

  assert.deepEqual(out, { kind: "pass" });
  assert.equal(w.lines.length, 0);
});

test("interceptClarify returns pass without writing for an untagged input request", () => {
  const w = new FakeWriter();
  const bridge = new AskBridge(new FakeForwarder(), (l) => w.write(l), undefined, undefined, "single", { delivered: 0 });

  const out = bridge.interceptClarify({ type: "extension_ui_request", id: "q1", method: "input", title: "just a question" });

  assert.deepEqual(out, { kind: "pass" });
  assert.equal(w.lines.length, 0);
});

test("processRpcLine returns a suspended outcome for a tagged input line and does not reach the forwarder", () => {
  const { f, bridge } = makeClarifyBridge("single", 0);
  const acc = makeAcc();

  const out = processRpcLine(rpcLine(clarifyInput("q1", "which file?")), acc, bridge);

  assert.deepEqual(out, suspendedOutcome("q1", "which file?"));
  assert.equal(f.inputCalls.length, 0);
});

test("processRpcLine auto-denies a parallel-mode clarify without forwarding it to the parent UI", async () => {
  const { f, w, bridge } = makeClarifyBridge("parallel", 0);
  const acc = makeAcc();
  const out = processRpcLine(rpcLine(clarifyInput("q1", "which?")), acc, bridge);
  await flush();

  assert.deepEqual(out, { settled: false });
  assert.equal(f.inputCalls.length, 0);
  assertAutoDenied(w, "q1");
});

test("ChildSession.sendPrompt resolves suspended for a tagged input line in single mode", async () => {
  const t = new FakeTransport();
  const session = new ChildSession(t, new FakeForwarder(), makeAcc(), undefined, undefined, undefined, "single", { delivered: 0 });

  const p = session.sendPrompt("task");
  t.emitLine(JSON.stringify({ type: "extension_ui_request", id: "q1", method: "input", title: CLARIFY_TAG + "which file?" }));

  assert.deepEqual(await p, { settled: false, suspended: true, exitCode: 0, aborted: false, clarify: { id: "q1", question: "which file?" } });
});

test("a second clarify while one is suspended is auto-denied so the duplicate tool call can't hang the turn", async () => {
  const t = new FakeTransport();
  const session = clarifySession(t);
  await suspendOnClarify(session, t, "q1", "first?");

  t.emitLine(rpcLine(clarifyInput("q2", "dup?")));
  await flush();

  assert.deepEqual(uiResponses(t), [clarifyDeniedResponse("q2")]);
});

test("ChildSession.resume resolves settled after the suspended turn settles", async () => {
  const t = new FakeTransport();
  const session = clarifySession(t);
  await suspendOnClarify(session, t, "q1", "which file?");

  const resumeP = session.resume();
  settle(t);

  assert.deepEqual(await resumeP, SETTLED);
});

test("ChildSession defaults keep sendPrompt working without explicit mode and budget", async () => {
  const t = new FakeTransport();
  const session = new ChildSession(t, new FakeForwarder(), makeAcc());

  const p = session.sendPrompt("task");
  t.emitLine(JSON.stringify({ type: "agent_settled" }));

  assert.deepEqual(await p, { settled: true, suspended: false, exitCode: 0, aborted: false });
});
