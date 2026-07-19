import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AskBridge,
  ChildSession,
  processRpcLine,
  type ChildTransport,
  type UiForwarder,
} from "./bridge.ts";
import type { SingleResult } from "./child.ts";

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
  selectResult: string | undefined = "chosen";
  inputResult: string | undefined = "typed";
  editorResult: string | undefined = "edited";

  confirm(title: string, message: string, opts?: any) {
    this.confirmCalls.push({ title, message, opts });
    return this.confirmShouldThrow ? Promise.reject(new Error("nope")) : Promise.resolve(this.confirmResult);
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

  assert.deepEqual(f.confirmCalls, [{ title: "T", message: "M", opts: { signal: undefined } }]);
  assert.deepEqual(w.json(0), { type: "extension_ui_response", id: "c1", confirmed: true });
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

test("processRpcLine pushes a tool_result_end message and stays unsettled", () => {
  const acc = makeAcc();
  const bridge = new AskBridge(new FakeForwarder(), () => {});
  const msg = { role: "tool", content: [{ type: "toolResult", toolCallId: "t1", content: "ok" }] };

  const outcome = processRpcLine(JSON.stringify({ type: "tool_result_end", message: msg }), acc, bridge);

  assert.equal(outcome.settled, false);
  assert.equal(acc.messages.length, 1);
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
  assert.deepEqual(await p, { settled: true, exitCode: 0, aborted: false });
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

  assert.deepEqual(await p, { settled: false, exitCode: 7, aborted: false });
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
