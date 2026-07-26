import { test } from "node:test";
import assert from "node:assert/strict";

import { RAILS, register } from "./index.ts";
import type { DedupLog } from "./dedup.ts";

const MODULE_FILE = "/tmp/liubai-rails/subject.py";
const TEST_FILE = "/tmp/liubai-rails/tests/test_subject.py";
const NON_PYTHON_FILE = "/tmp/liubai-rails/notes.md";

const TOOL_RESULT = "edited 1 file";

const LONG_TEST = [
  "def test_processes_every_record():",
  "    a = 1",
  "    b = 2",
  "    c = 3",
  "    d = 4",
  "    e = 5",
  "    f = 6",
  "    g = 7",
  "    h = 8",
  "    assert a + b + c + d + e + f + g + h == 36",
  "",
].join("\n");

type ToolOutcome = { blocked: boolean; reason?: string; text: string };
type LogEntry = Parameters<DedupLog>[0];

function fakePi() {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const pi = {
    on: (name: string, fn: (event: any, ctx?: any) => any) => handlers.set(name, fn),
    registerTool: () => {},
  };
  return { pi: pi as any, handlers };
}

function notifyingCtx(notices: string[]) {
  return { hasUI: true, ui: { notify: (message: string) => notices.push(message) } };
}

const railFailures = (logs: LogEntry[]) => logs.filter((entry) => entry.kind === "rail-error");

function railsSession(ctx?: unknown) {
  const { pi, handlers } = fakePi();
  const logs: LogEntry[] = [];
  register(pi, { logDedup: (entry) => logs.push(entry) });

  async function apply(
    callId: string,
    toolName: string,
    input: Record<string, unknown>,
    path: string,
  ): Promise<ToolOutcome> {
    const callEvent = { type: "tool_call", toolCallId: callId, toolName, input };
    const callResult = await handlers.get("tool_call")?.(callEvent, ctx);
    if (callResult?.block) return { blocked: true, reason: callResult.reason, text: "" };

    const resultEvent = {
      type: "tool_result",
      toolCallId: callId,
      toolName,
      input: { path },
      content: [{ type: "text", text: TOOL_RESULT }],
      isError: false,
    };
    const resultOut = await handlers.get("tool_result")?.(resultEvent);
    const content = resultOut?.content ?? resultEvent.content;
    return { blocked: false, text: content.map((c: any) => c.text).join("") };
  }

  const write = (callId: string, path: string, content: string) =>
    apply(callId, "write", { path, content }, path);

  return { apply, write, logs };
}

async function applyEdit(
  callId: string,
  path: string,
  oldText: string,
  newText: string,
): Promise<ToolOutcome> {
  return applyEditCall(callId, path, { path, edits: [{ oldText, newText }] });
}

async function applyEditCall(
  callId: string,
  path: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  return railsSession().apply(callId, "edit", input, path);
}

async function applyWrite(callId: string, path: string, content: string): Promise<ToolOutcome> {
  return railsSession().write(callId, path, content);
}

test("a newly introduced comment is rejected before the edit runs", async () => {
  const outcome = await applyEdit("comment", MODULE_FILE, "x = 1", "x = 1  # noise");

  assert.equal(outcome.blocked, true);
  assert.match(outcome.reason ?? "", /no_added_comments/);
});

test("a comment added through the legacy flat edit shape is still rejected", async () => {
  const outcome = await applyEditCall("legacy", MODULE_FILE, {
    path: MODULE_FILE,
    oldText: "x = 1",
    newText: "x = 1  # noise",
  });

  assert.equal(outcome.blocked, true);
  assert.match(outcome.reason ?? "", /no_added_comments/);
});

test("a long test's refactor nudge rides along on the tool result", async () => {
  const outcome = await applyEdit("long", TEST_FILE, "", LONG_TEST);

  assert.equal(outcome.blocked, false);
  assert.match(outcome.text, /edited 1 file/);
  assert.match(outcome.text, /Long test detected/);
});

test("an edit that triggers no rail leaves the result untouched", async () => {
  const outcome = await applyEdit("clean", NON_PYTHON_FILE, "old", "new");

  assert.equal(outcome.blocked, false);
  assert.equal(outcome.text, TOOL_RESULT);
});

test("a comment written into a Python file is rejected before the write runs", async () => {
  const outcome = await applyWrite("written-comment", MODULE_FILE, "x = 1  # noise\n");

  assert.equal(outcome.blocked, true);
  assert.match(outcome.reason ?? "", /no_added_comments/);
});

test("a write-named call carrying a foreign payload reaches no rail", async () => {
  const session = railsSession();

  const outcome = await session.apply("foreign", "write", { path: MODULE_FILE, content: 42 }, MODULE_FILE);

  assert.equal(outcome.blocked, false);
  assert.deepEqual(railFailures(session.logs), []);
});

async function withoutPython<T>(action: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = "";
  try {
    return await action();
  } finally {
    process.env.PATH = original;
  }
}

test("a rail that cannot be run is logged instead of silently passing the write", async () => {
  const session = railsSession();

  const outcome = await withoutPython(() => session.write("unrunnable", MODULE_FILE, "x = 1  # noise\n"));

  assert.equal(outcome.blocked, false);
  assert.deepEqual(
    railFailures(session.logs).map((entry) => entry.key),
    RAILS,
  );
});

test("a broken rail is reported to the operator once, however many rails fail", async () => {
  const notices: string[] = [];
  const session = railsSession(notifyingCtx(notices));

  await withoutPython(() => session.write("first", MODULE_FILE, "x = 1\n"));
  await withoutPython(() => session.write("second", MODULE_FILE, "y = 2\n"));

  assert.equal(notices.length, 1);
});

function finalizeAssistant(text: string) {
  const { pi, handlers } = fakePi();
  register(pi);
  const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } };
  return handlers.get("message_end")?.(event);
}

test("filler is stripped from a finalized assistant message", () => {
  const out = finalizeAssistant("Certainly. The rails fire on edit.");

  assert.equal(out.message.content[0].text, "The rails fire on edit.");
});

test("LIUBAI_RAILS_OFF leaves a finalized assistant message untouched", async () => {
  const out = await withRailsDisabled(() => finalizeAssistant("Certainly. The rails fire on edit."));

  assert.equal(out, undefined);
});

async function withRailsDisabled<T>(action: () => Promise<T>): Promise<T> {
  process.env.LIUBAI_RAILS_OFF = "1";
  try {
    return await action();
  } finally {
    delete process.env.LIUBAI_RAILS_OFF;
  }
}

test("LIUBAI_RAILS_OFF lets a would-be-blocked edit through untouched", async () => {
  const outcome = await withRailsDisabled(() =>
    applyEdit("disabled", MODULE_FILE, "x = 1", "x = 1  # noise"),
  );

  assert.equal(outcome.blocked, false);
  assert.equal(outcome.text, TOOL_RESULT);
});
