import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectMode,
  truncateChildOutput,
  aggregateUsage,
  getFinalOutput,
  getResultOutput,
  MAX_PARALLEL_TASKS,
  PER_TASK_OUTPUT_CAP,
  type SingleResult,
} from "./child.ts";

const assistantSaying = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

const childResult = (overrides: Partial<SingleResult>): SingleResult => ({
  task: "do the thing",
  exitCode: 0,
  messages: [],
  stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  ...overrides,
});

test("a lone task selects single mode", () => {
  const selection = selectMode({ task: "summarize the changelog" });

  assert.deepEqual(selection, { kind: "single" });
});

test("a tasks array selects parallel mode", () => {
  const selection = selectMode({ tasks: [{ task: "lint" }, { task: "typecheck" }] });

  assert.deepEqual(selection, { kind: "parallel" });
});

test("providing both task and tasks is rejected as ambiguous", () => {
  const selection = selectMode({ task: "one", tasks: [{ task: "two" }] });

  assert.equal(selection.kind, "error");
});

test("providing neither task nor tasks is rejected", () => {
  const selection = selectMode({});

  assert.equal(selection.kind, "error");
});

test("more parallel tasks than the cap are rejected", () => {
  const tooMany = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({ task: `task ${i}` }));

  const selection = selectMode({ tasks: tooMany });

  assert.equal(selection.kind, "error");
});

test("output within the cap passes through untouched", () => {
  const output = "the child finished cleanly";

  assert.equal(truncateChildOutput(output), output);
});

test("output over the cap is truncated with a byte-count notice", () => {
  const oversized = "x".repeat(PER_TASK_OUTPUT_CAP + 512);

  const truncated = truncateChildOutput(oversized);

  assert.ok(Buffer.byteLength(truncated, "utf8") < oversized.length);
  assert.match(truncated, /512 bytes omitted/);
});

test("usage is summed across every child", () => {
  const results = [
    childResult({ usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 2 } }),
    childResult({ usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 0, turns: 3 } }),
  ];

  const total = aggregateUsage(results);

  assert.equal(total.input, 150);
  assert.equal(total.output, 30);
  assert.equal(total.cost, 0.03);
  assert.equal(total.turns, 5);
});

test("the last assistant text is returned as the final output", () => {
  const messages = [assistantSaying("first pass"), assistantSaying("final answer")];

  assert.equal(getFinalOutput(messages as any), "final answer");
});

test("a failed child surfaces its error message over its partial output", () => {
  const failed = childResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "provider timed out",
    messages: [assistantSaying("partial work so far") as any],
  });

  assert.equal(getResultOutput(failed), "provider timed out");
});
