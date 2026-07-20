import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AskBridge,
  ChildSession,
  DialogGate,
  processRpcLine,
  type ChildTransport,
  type UiForwarder,
} from "./bridge.ts";
import { CLARIFY_TAG, MAX_CLARIFY, type SingleResult } from "./child.ts";

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
    return JSON.parse(this.lines[i]);
  }
}

class FakeTransport implements ChildTransport {
  writes: string[] = [];
  private lineCbs: Array<(line: string) => void> = [];
  private closeCbs: Array<(code: number | null) => void> = [];
  killed = false;

  write(line: string) {
    this.writes.push(line);
  }
  onLine(cb: (line: string) => void) {
    this.lineCbs.push(cb);
  }
  onClose(cb: (code: number | null) => void) {
    this.closeCbs.push(cb);
  }
  kill() {
    this.killed = true;
  }
  emitLine(line: string) {
    for (const cb of this.lineCbs) cb(line);
  }
  emitClose(code: number | null) {
    for (const cb of this.closeCbs) cb(code);
  }
  writtenJson() {
    return this.writes.map((w) => JSON.parse(w));
  }
}

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

  assert.equal(f.confirmCalls[0].opts.timeout, 5000);
});

test("AskBridge select writes {id, value} for a string and {id, cancelled} for undefined", async () => {
  const f = new FakeForwarder();
  f.selectResult = "x";
  const w = new FakeWriter();
  const bridge = new AskBridge(f, (l) => w.write(l));

  await bridge.handle({ type: "extension_ui_request", id: "s1", method: "select", title: "T", options: ["a", "b"] });
  f.selectResult = undefined;
  await bridge.handle({ type: "extension_ui_request", id: "s2", method: "select", title: "T", options: ["a"] });

  assert.deepEqual(w.json(0), { type: "extension_ui_response", id: "s1", value: "x" });
  assert.deepEqual(w.json(1), { type: "extension_ui_response", id: "s2", cancelled: true });
});

test("AskBridge input writes {id, value} for a string and {id, cancelled} for undefined", async () => {
  const f = new FakeForwarder();
  f.inputResult = "typed";
  const w = new FakeWriter();
  const bridge = new AskBridge(f, (l) => w.write(l));

  await bridge.handle({ type: "extension_ui_request", id: "i1", method: "input", title: "T", placeholder: "p" });
  f.inputResult = undefined;
  await bridge.handle({ type: "extension_ui_request", id: "i2", method: "input", title: "T" });

  assert.deepEqual(w.json(0), { type: "extension_ui_response", id: "i1", value: "typed" });
  assert.deepEqual(w.json(1), { type: "extension_ui_response", id: "i2", cancelled: true });
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
  const f = new FakeForwarder();
  const w = new FakeWriter();
  const bridge = new AskBridge(f, (l) => w.write(l));

  await bridge.handle({ type: "extension_ui_request", id: "x", method: "setStatus", statusKey: "k", statusText: "s" });
  await bridge.handle({ type: "extension_ui_request", id: "x", method: "setWidget", widgetKey: "k", widgetLines: ["l"] });
  await bridge.handle({ type: "extension_ui_request", id: "x", method: "setTitle", title: "t" });
  await bridge.handle({ type: "extension_ui_request", id: "x", method: "set_editor_text", text: "t" });

  assert.equal(w.lines.length, 0);
  assert.equal(f.confirmCalls.length, 0);
  assert.equal(f.selectCalls.length, 0);
  assert.equal(f.inputCalls.length, 0);
  assert.equal(f.editorCalls.length, 0);
  assert.equal(f.notifyCalls.length, 0);
});

test("AskBridge with hasUI false cancels a confirm immediately without calling the forwarder", async () => {
  const f = new FakeForwarder();
  f.hasUI = false;
  const w = new FakeWriter();
  const bridge = new AskBridge(f, (l) => w.write(l));

  await bridge.handle({ type: "extension_ui_request", id: "c1", method: "confirm", title: "T", message: "M" });

  assert.equal(f.confirmCalls.length, 0);
  assert.deepEqual(w.json(0), { type: "extension_ui_response", id: "c1", cancelled: true });
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
  const bridge = new AskBridge(new FakeForwarder(), () => {});

  const outcome = processRpcLine(JSON.stringify({ type: "message_end", message: assistantMsg() }), acc, bridge);

  assert.equal(outcome.settled, false);
  assert.equal(acc.messages.length, 1);
  assert.equal(acc.usage.input, 10);
  assert.equal(acc.usage.output, 5);
  assert.equal(acc.usage.cost, 0.02);
  assert.equal(acc.usage.contextTokens, 15);
  assert.equal(acc.usage.turns, 1);
  assert.equal(acc.model, "m");
  assert.equal(acc.stopReason, "end");
});

test("processRpcLine accumulates a toolResult message arriving via message_end", () => {
  const acc = makeAcc();
  const bridge = new AskBridge(new FakeForwarder(), () => {});
  const msg = { role: "toolResult", content: [{ type: "toolResult", toolCallId: "t1", content: "ok" }] };

  const outcome = processRpcLine(JSON.stringify({ type: "message_end", message: msg }), acc, bridge);

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

test("processRpcLine routes an extension_ui_request to the bridge", async () => {
  const f = new FakeForwarder();
  const bridge = new AskBridge(f, () => {});
  const acc = makeAcc();

  processRpcLine(
    JSON.stringify({ type: "extension_ui_request", id: "q1", method: "confirm", title: "t", message: "m" }),
    acc,
    bridge,
  );
  await flush();

  assert.equal(f.confirmCalls.length, 1);
});

test("ChildSession.sendPrompt writes the prompt and resolves only on agent_settled", async () => {
  const t = new FakeTransport();
  const session = new ChildSession(t, new FakeForwarder(), makeAcc());

  const p = session.sendPrompt("do it");
  assert.deepEqual(t.writtenJson()[0], { type: "prompt", message: "do it" });

  t.emitLine(JSON.stringify({ type: "agent_end", messages: [], willRetry: false }));

  let resolved = false;
  p.then(() => {
    resolved = true;
  });
  await flush();
  assert.equal(resolved, false);

  t.emitLine(JSON.stringify({ type: "agent_settled" }));
  assert.deepEqual(await p, { settled: true, suspended: false, exitCode: 0, aborted: false });
});

test("ChildSession.sendPrompt reuses the same transport across turns", async () => {
  const t = new FakeTransport();
  const session = new ChildSession(t, new FakeForwarder(), makeAcc());

  const p1 = session.sendPrompt("first");
  t.emitLine(JSON.stringify({ type: "agent_settled" }));
  await p1;

  const p2 = session.sendPrompt("second");
  t.emitLine(JSON.stringify({ type: "agent_settled" }));
  await p2;

  const prompts = t.writtenJson().filter((o) => o.type === "prompt");
  assert.deepEqual(prompts, [
    { type: "prompt", message: "first" },
    { type: "prompt", message: "second" },
  ]);
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
  f.confirmResult = true;
  const session = new ChildSession(t, f, makeAcc());

  const p = session.sendPrompt("task");
  t.emitLine(
    JSON.stringify({ type: "extension_ui_request", id: "q1", method: "confirm", title: "ok?", message: "proceed?" }),
  );
  await flush();

  assert.equal(f.confirmCalls.length, 1);
  const responses = t.writtenJson().filter((o) => o.type === "extension_ui_response");
  assert.deepEqual(responses, [{ type: "extension_ui_response", id: "q1", confirmed: true }]);

  t.emitLine(JSON.stringify({ type: "agent_settled" }));
  await p;
});

test("a pending parent confirm is dismissed when the child dies mid-ask", async () => {
  const t = new FakeTransport();
  const f = new FakeForwarder();
  f.confirmPending = true;
  const session = new ChildSession(t, f, makeAcc());

  const p = session.sendPrompt("task");
  t.emitLine(
    JSON.stringify({ type: "extension_ui_request", id: "q1", method: "confirm", title: "ok?", message: "proceed?" }),
  );
  await flush();

  assert.equal(f.confirmCalls.length, 1);

  const confirmPromise = f.confirmCalls[0].opts?.signal ? new Promise<void>((resolve) => {
    f.confirmCalls[0].opts.signal.addEventListener("abort", () => resolve(), { once: true });
  }) : Promise.resolve();

  t.emitClose(9);
  await confirmPromise;
  await flush();

  const result = await p;
  assert.deepEqual(result, { settled: false, suspended: false, exitCode: 9, aborted: false });
});

test("a pending parent confirm is dismissed on parent abort", async () => {
  const t = new FakeTransport();
  const f = new FakeForwarder();
  f.confirmPending = true;
  const toolController = new AbortController();
  const session = new ChildSession(t, f, makeAcc(), undefined, toolController.signal);

  const p = session.sendPrompt("task");
  t.emitLine(
    JSON.stringify({ type: "extension_ui_request", id: "q1", method: "confirm", title: "ok?", message: "proceed?" }),
  );
  await flush();

  assert.equal(f.confirmCalls.length, 1);

  const confirmPromise = f.confirmCalls[0].opts?.signal ? new Promise<void>((resolve) => {
    f.confirmCalls[0].opts.signal.addEventListener("abort", () => {
      setImmediate(() => resolve());
    });
  }) : Promise.resolve();

  toolController.abort();
  t.emitClose(1);
  await confirmPromise;
  await flush();

  const result = await p;
  assert.deepEqual(result, { settled: false, suspended: false, exitCode: 1, aborted: true });
});

test("concurrent asks from two children show one parent dialog at a time", async () => {
  const gate = new DialogGate();
  const f = new FakeForwarder();
  f.confirmManual = true;
  const t1 = new FakeTransport();
  const t2 = new FakeTransport();
  const s1 = new ChildSession(t1, f, makeAcc(), undefined, undefined, gate);
  const s2 = new ChildSession(t2, f, makeAcc(), undefined, undefined, gate);

  const p1 = s1.sendPrompt("task1");
  const p2 = s2.sendPrompt("task2");
  t1.emitLine(JSON.stringify({ type: "extension_ui_request", id: "a1", method: "confirm", title: "t1", message: "m1" }));
  t2.emitLine(JSON.stringify({ type: "extension_ui_request", id: "a2", method: "confirm", title: "t2", message: "m2" }));
  await flush();

  assert.equal(f.confirmCalls.length, 1);

  f.pendingConfirms.shift()!(true);
  await flush();

  assert.equal(f.confirmCalls.length, 2);

  f.pendingConfirms.shift()!(false);
  await flush();

  const responses1 = t1.writtenJson().filter((o) => o.type === "extension_ui_response");
  const responses2 = t2.writtenJson().filter((o) => o.type === "extension_ui_response");
  assert.deepEqual(responses1, [{ type: "extension_ui_response", id: "a1", confirmed: true }]);
  assert.deepEqual(responses2, [{ type: "extension_ui_response", id: "a2", confirmed: false }]);

  t1.emitLine(JSON.stringify({ type: "agent_settled" }));
  t2.emitLine(JSON.stringify({ type: "agent_settled" }));
  await p1;
  await p2;
});

test("an ask queued behind another dialog is skipped when its child dies while waiting", async () => {
  const gate = new DialogGate();
  const f = new FakeForwarder();
  f.confirmManual = true;
  const t1 = new FakeTransport();
  const t2 = new FakeTransport();
  const s1 = new ChildSession(t1, f, makeAcc(), undefined, undefined, gate);
  const s2 = new ChildSession(t2, f, makeAcc(), undefined, undefined, gate);

  const p1 = s1.sendPrompt("task1");
  const p2 = s2.sendPrompt("task2");
  t1.emitLine(JSON.stringify({ type: "extension_ui_request", id: "a1", method: "confirm", title: "t1", message: "m1" }));
  t2.emitLine(JSON.stringify({ type: "extension_ui_request", id: "a2", method: "confirm", title: "t2", message: "m2" }));
  await flush();

  assert.equal(f.confirmCalls.length, 1);

  t2.emitClose(3);
  f.pendingConfirms.shift()!(true);
  await flush();

  assert.equal(f.confirmCalls.length, 1);
  assert.deepEqual(await p2, { settled: false, suspended: false, exitCode: 3, aborted: false });

  t1.emitLine(JSON.stringify({ type: "agent_settled" }));
  await p1;
});

test("parallel children resolve asks independently by id with no cross-talk", async () => {
  const t1 = new FakeTransport();
  const f1 = new FakeForwarder();
  const session1 = new ChildSession(t1, f1, makeAcc());

  const t2 = new FakeTransport();
  const f2 = new FakeForwarder();
  const session2 = new ChildSession(t2, f2, makeAcc());

  const p1 = session1.sendPrompt("task1");
  const p2 = session2.sendPrompt("task2");

  f1.confirmResult = true;
  f2.confirmResult = false;

  t1.emitLine(
    JSON.stringify({ type: "extension_ui_request", id: "a1", method: "confirm", title: "t1", message: "m1" }),
  );
  t2.emitLine(
    JSON.stringify({ type: "extension_ui_request", id: "a2", method: "confirm", title: "t2", message: "m2" }),
  );
  await flush();

  await flush();

  const responses1 = t1.writtenJson().filter((o) => o.type === "extension_ui_response");
  const responses2 = t2.writtenJson().filter((o) => o.type === "extension_ui_response");

  assert.deepEqual(responses1, [{ type: "extension_ui_response", id: "a1", confirmed: true }]);
  assert.deepEqual(responses2, [{ type: "extension_ui_response", id: "a2", confirmed: false }]);

  t1.emitLine(JSON.stringify({ type: "agent_settled" }));
  t2.emitLine(JSON.stringify({ type: "agent_settled" }));
  await p1;
  await p2;
});

test("interceptClarify returns the clarifyId and question for a tagged single-mode request under budget and writes no response", () => {
  const w = new FakeWriter();
  const bridge = new AskBridge(new FakeForwarder(), (l) => w.write(l), undefined, undefined, "single", { delivered: 0 });

  const out = bridge.interceptClarify({ id: "q1", method: "input", title: CLARIFY_TAG + "which file?" });

  assert.deepEqual(out, { kind: "suspend", clarifyId: "q1", question: "which file?" });
  assert.equal(w.lines.length, 0);
});

test("interceptClarify auto-denies and returns denied in parallel mode", () => {
  const w = new FakeWriter();
  const bridge = new AskBridge(new FakeForwarder(), (l) => w.write(l), undefined, undefined, "parallel", { delivered: 0 });

  const out = bridge.interceptClarify({ id: "q1", method: "input", title: CLARIFY_TAG + "which?" });

  assert.deepEqual(out, { kind: "denied" });
  assert.deepEqual(w.json(0), { type: "extension_ui_response", id: "q1", value: "proceed with best judgment" });
});

test("interceptClarify auto-denies and returns denied when the delivered budget is at the cap", () => {
  const w = new FakeWriter();
  const bridge = new AskBridge(new FakeForwarder(), (l) => w.write(l), undefined, undefined, "single", { delivered: MAX_CLARIFY });

  const out = bridge.interceptClarify({ id: "q1", method: "input", title: CLARIFY_TAG + "which?" });

  assert.deepEqual(out, { kind: "denied" });
  assert.deepEqual(w.json(0), { type: "extension_ui_response", id: "q1", value: "proceed with best judgment" });
});

test("interceptClarify returns pass without writing for a non-input request", () => {
  const w = new FakeWriter();
  const bridge = new AskBridge(new FakeForwarder(), (l) => w.write(l), undefined, undefined, "single", { delivered: 0 });

  const out = bridge.interceptClarify({ id: "q1", method: "confirm", title: CLARIFY_TAG + "which?" });

  assert.deepEqual(out, { kind: "pass" });
  assert.equal(w.lines.length, 0);
});

test("interceptClarify returns pass without writing for an untagged input request", () => {
  const w = new FakeWriter();
  const bridge = new AskBridge(new FakeForwarder(), (l) => w.write(l), undefined, undefined, "single", { delivered: 0 });

  const out = bridge.interceptClarify({ id: "q1", method: "input", title: "just a question" });

  assert.deepEqual(out, { kind: "pass" });
  assert.equal(w.lines.length, 0);
});

test("processRpcLine returns a suspended outcome for a tagged input line and does not reach the forwarder", () => {
  const f = new FakeForwarder();
  const bridge = new AskBridge(f, () => {}, undefined, undefined, "single", { delivered: 0 });
  const acc = makeAcc();

  const out = processRpcLine(
    JSON.stringify({ type: "extension_ui_request", id: "q1", method: "input", title: CLARIFY_TAG + "which file?" }),
    acc,
    bridge,
  );

  assert.deepEqual(out, { settled: false, suspended: { clarifyId: "q1", question: "which file?" } });
  assert.equal(f.inputCalls.length, 0);
});

test("processRpcLine auto-denies a parallel-mode clarify without forwarding it to the parent UI", async () => {
  const f = new FakeForwarder();
  const w = new FakeWriter();
  const bridge = new AskBridge(f, (l) => w.write(l), undefined, undefined, "parallel", { delivered: 0 });
  const acc = makeAcc();

  const out = processRpcLine(
    JSON.stringify({ type: "extension_ui_request", id: "q1", method: "input", title: CLARIFY_TAG + "which?" }),
    acc,
    bridge,
  );
  await flush();

  assert.deepEqual(out, { settled: false });
  assert.equal(f.inputCalls.length, 0);
  assert.equal(w.lines.length, 1);
  assert.deepEqual(w.json(0), { type: "extension_ui_response", id: "q1", value: "proceed with best judgment" });
});

test("ChildSession.sendPrompt resolves suspended for a tagged input line in single mode", async () => {
  const t = new FakeTransport();
  const session = new ChildSession(t, new FakeForwarder(), makeAcc(), undefined, undefined, undefined, "single", { delivered: 0 });

  const p = session.sendPrompt("task");
  t.emitLine(JSON.stringify({ type: "extension_ui_request", id: "q1", method: "input", title: CLARIFY_TAG + "which file?" }));

  assert.deepEqual(await p, { settled: false, suspended: true, exitCode: 0, aborted: false, clarify: { id: "q1", question: "which file?" } });
});

test("ChildSession.resume resolves settled after the suspended turn settles", async () => {
  const t = new FakeTransport();
  const session = new ChildSession(t, new FakeForwarder(), makeAcc(), undefined, undefined, undefined, "single", { delivered: 0 });

  const p = session.sendPrompt("task");
  t.emitLine(JSON.stringify({ type: "extension_ui_request", id: "q1", method: "input", title: CLARIFY_TAG + "which file?" }));
  const suspended = await p;
  assert.equal(suspended.suspended, true);

  const resumeP = session.resume();
  t.emitLine(JSON.stringify({ type: "agent_settled" }));

  assert.deepEqual(await resumeP, { settled: true, suspended: false, exitCode: 0, aborted: false });
});

test("ChildSession defaults keep sendPrompt working without explicit mode and budget", async () => {
  const t = new FakeTransport();
  const session = new ChildSession(t, new FakeForwarder(), makeAcc());

  const p = session.sendPrompt("task");
  t.emitLine(JSON.stringify({ type: "agent_settled" }));

  assert.deepEqual(await p, { settled: true, suspended: false, exitCode: 0, aborted: false });
});
