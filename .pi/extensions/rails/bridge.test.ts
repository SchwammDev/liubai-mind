import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "./index.ts";

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

type EditOutcome = { blocked: boolean; reason?: string; text: string };

function fakePi() {
  const handlers = new Map<string, (event: any) => any>();
  const pi = { on: (name: string, fn: (event: any) => any) => handlers.set(name, fn) };
  return { pi: pi as any, handlers };
}

async function applyEdit(
  callId: string,
  path: string,
  oldText: string,
  newText: string,
): Promise<EditOutcome> {
  const { pi, handlers } = fakePi();
  register(pi);

  const callEvent = {
    type: "tool_call",
    toolCallId: callId,
    toolName: "edit",
    input: { path, oldText, newText },
  };
  const callResult = await handlers.get("tool_call")?.(callEvent);
  if (callResult?.block) return { blocked: true, reason: callResult.reason, text: "" };

  const resultEvent = {
    type: "tool_result",
    toolCallId: callId,
    toolName: "edit",
    input: { path },
    content: [{ type: "text", text: TOOL_RESULT }],
    isError: false,
  };
  const resultOut = await handlers.get("tool_result")?.(resultEvent);
  const content = resultOut?.content ?? resultEvent.content;
  return { blocked: false, text: content.map((c: any) => c.text).join("") };
}

test("a newly introduced comment is rejected before the edit runs", async () => {
  const outcome = await applyEdit("comment", MODULE_FILE, "x = 1", "x = 1  # noise");

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
