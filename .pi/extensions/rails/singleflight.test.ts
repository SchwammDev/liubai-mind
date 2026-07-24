import { test } from "node:test";
import assert from "node:assert/strict";

import { withoutDuplicateToolCalls, withSingleFlight, type InFlightCalls } from "./singleflight.ts";

function harness() {
  const calls: InFlightCalls = new Map();
  const logs: any[] = [];
  let runs = 0;
  const delegate = {
    name: "bash",
    execute: async (_id: string, params: any) => {
      runs += 1;
      if (params?.fail) throw new Error("boom");
      return { content: [{ type: "text", text: `ran#${runs}` }] };
    },
  };
  const tool = withSingleFlight(delegate, calls, (entry) => logs.push(entry));
  return { tool, delegate, calls, logs, runs: () => runs };
}

test("a tool call delivered twice under one id executes once and shares the result", async () => {
  const h = harness();

  const [first, second] = await Promise.all([
    h.tool.execute("call-1", {}, undefined, undefined, undefined),
    h.tool.execute("call-1", {}, undefined, undefined, undefined),
  ]);

  assert.equal(h.runs(), 1);
  assert.equal(first, second);
  assert.ok(h.logs.some((entry) => entry.kind === "duplicate-id"));
});

test("calls with distinct ids execute independently", async () => {
  const h = harness();

  await h.tool.execute("call-1", {}, undefined, undefined, undefined);
  await h.tool.execute("call-2", {}, undefined, undefined, undefined);

  assert.equal(h.runs(), 2);
  assert.equal(h.logs.length, 0);
});

test("a duplicate arriving after the first completed still coalesces", async () => {
  const h = harness();

  const first = await h.tool.execute("call-1", {}, undefined, undefined, undefined);
  const second = await h.tool.execute("call-1", {}, undefined, undefined, undefined);

  assert.equal(h.runs(), 1);
  assert.equal(first, second);
});

test("a failed first execution propagates the same failure to the duplicate", async () => {
  const h = harness();

  const outcomes = await Promise.allSettled([
    h.tool.execute("call-1", { fail: true }, undefined, undefined, undefined),
    h.tool.execute("call-1", { fail: true }, undefined, undefined, undefined),
  ]);

  assert.equal(h.runs(), 1);
  assert.ok(outcomes.every((outcome) => outcome.status === "rejected"));
});

test("wrapping an already wrapped tool returns it unchanged", () => {
  const h = harness();

  const rewrapped = withSingleFlight(h.tool, h.calls, () => {});

  assert.equal(rewrapped, h.tool);
});

test("the wrapper preserves the delegate's name and other properties", () => {
  const delegate = { name: "grep", label: "Grep", execute: async () => ({}) };

  const tool = withSingleFlight(delegate, new Map(), () => {});

  assert.equal(tool.name, "grep");
  assert.equal((tool as any).label, "Grep");
});

const toolCall = (id: string, marker: string) => ({ type: "toolCall", id, name: "bash", arguments: { marker } });

test("a message carrying the same tool call id twice keeps only the last copy", () => {
  const logs: any[] = [];
  const message = {
    role: "assistant",
    content: [
      toolCall("call-A", "early"),
      toolCall("call-B", "early"),
      { type: "thinking", thinking: "t" },
      toolCall("call-A", "late"),
      toolCall("call-B", "late"),
    ],
  };

  const deduped = withoutDuplicateToolCalls(message, (entry) => logs.push(entry));

  assert.deepEqual(
    deduped?.content.map((part: any) => [part.type, part.arguments?.marker]),
    [["thinking", undefined], ["toolCall", "late"], ["toolCall", "late"]],
  );
  assert.equal(logs.filter((entry) => entry.kind === "duplicate-id").length, 2);
});

test("a message without duplicate tool calls is reported unchanged", () => {
  const message = {
    role: "assistant",
    content: [toolCall("call-A", "only"), toolCall("call-B", "only")],
  };

  assert.equal(withoutDuplicateToolCalls(message, () => {}), null);
});
