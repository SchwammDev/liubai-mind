import { test } from "node:test";
import assert from "node:assert/strict";

import type { Message } from "@earendil-works/pi-ai";

import { COLLAPSED_ITEM_COUNT, type SingleResult, type SubagentDetails } from "./child.ts";
import { describeCall, describeResult, type ViewNode, type ViewTheme } from "./view.ts";

const plainTheme: ViewTheme = { fg: (_color, text) => text, bold: (text) => text };

const said = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as Message;

const ranTool = (name: string, args: Record<string, unknown>) =>
  ({ role: "assistant", content: [{ type: "toolCall", name, arguments: args }] }) as unknown as Message;

const child = (overrides: Partial<SingleResult> = {}): SingleResult => ({
  task: "do the thing",
  exitCode: 0,
  messages: [],
  stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  ...overrides,
});

const spawnResult = (details: SubagentDetails, text = "summary") => ({
  content: [{ type: "text", text }],
  details,
});

const shown = (nodes: ViewNode[]) => nodes.map((n) => (n.kind === "spacer" ? "" : n.text)).join("\n");

const kindsOf = (nodes: ViewNode[]) => [...new Set(nodes.map((n) => n.kind))];

const single = (result: SingleResult): SubagentDetails => ({ mode: "single", results: [result] });

const parallel = (...results: SingleResult[]): SubagentDetails => ({ mode: "parallel", results });

test("a result the extension never populated falls back to the tool's own text", () => {
  const nodes = describeResult(spawnResult({ mode: "single", results: [] }, "nothing ran"), false, plainTheme);

  assert.equal(shown(nodes), "nothing ran");
});

test("a failed single child shows its stop reason and error", () => {
  const failed = child({ exitCode: 1, stopReason: "error", errorMessage: "model refused" });

  const nodes = describeResult(spawnResult(single(failed)), false, plainTheme);

  assert.match(shown(nodes), /✗ do the thing \[error\]/);
  assert.match(shown(nodes), /Error: model refused/);
});

test("a single child with nothing to show says so", () => {
  const nodes = describeResult(spawnResult(single(child())), false, plainTheme);

  assert.match(shown(nodes), /✓ do the thing\n\(no output\)/);
});

test("a collapsed single child hides the earliest items behind an expand hint", () => {
  const many = Array.from({ length: COLLAPSED_ITEM_COUNT + 3 }, (_, i) => said(`step ${i}`));

  const nodes = describeResult(spawnResult(single(child({ messages: many }))), false, plainTheme);

  assert.match(shown(nodes), /\.\.\. 3 earlier items/);
  assert.match(shown(nodes), /\(Ctrl\+O to expand\)/);
});

test("a collapsed single child clips each item to its first three lines", () => {
  const long = said(["one", "two", "three", "four"].join("\n"));

  const nodes = describeResult(spawnResult(single(child({ messages: [long] }))), false, plainTheme);

  assert.match(shown(nodes), /one\ntwo\nthree/);
  assert.doesNotMatch(shown(nodes), /four/);
});

test("an expanded single child shows the task it was given and its report", () => {
  const done = child({ messages: [said("the report")], finalReport: "the report" });

  const nodes = describeResult(spawnResult(single(done)), true, plainTheme);

  assert.match(shown(nodes), /─── Task ───\ndo the thing/);
  assert.ok(kindsOf(nodes).includes("markdown"), "the report should render as markdown");
});

test("an expanded single child lists the tools it called", () => {
  const worked = child({ messages: [ranTool("bash", { command: "ls" })] });

  const nodes = describeResult(spawnResult(single(worked)), true, plainTheme);

  assert.match(shown(nodes), /→ \$ ls/);
});

test("a single child's usage is reported with the model that ran it", () => {
  const billed = child({ model: "some-model", usage: { ...child().usage, input: 1200, turns: 2 } });

  const nodes = describeResult(spawnResult(single(billed)), false, plainTheme);

  assert.match(shown(nodes), /2 turns ↑1\.2k some-model/);
});

test("a running parallel batch counts what is still in flight", () => {
  const nodes = describeResult(spawnResult(parallel(child(), child({ exitCode: -1 }))), false, plainTheme);

  assert.match(shown(nodes), /⏳ parallel 1\/2 done, 1 running/);
});

test("a running parallel batch withholds the total until every child is done", () => {
  const billed = child({ usage: { ...child().usage, input: 1000, cost: 0.5 } });

  const nodes = describeResult(spawnResult(parallel(billed, child({ exitCode: -1 }))), false, plainTheme);

  assert.doesNotMatch(shown(nodes), /Total:/);
});

test("a finished parallel batch with a failure is marked partial", () => {
  const nodes = describeResult(spawnResult(parallel(child(), child({ exitCode: 1 }))), false, plainTheme);

  assert.match(shown(nodes), /◐ parallel 1\/2 tasks/);
});

test("a finished parallel batch totals the usage of every child", () => {
  const billed = () => child({ usage: { ...child().usage, input: 1000, turns: 1 } });

  const nodes = describeResult(spawnResult(parallel(billed(), billed())), false, plainTheme);

  assert.match(shown(nodes), /Total: 2 turns ↑2\.0k/);
});

test("a parallel batch still running stays collapsed even when expanded", () => {
  const nodes = describeResult(spawnResult(parallel(child(), child({ exitCode: -1 }))), true, plainTheme);

  assert.deepEqual(kindsOf(nodes), ["text"]);
  assert.match(shown(nodes), /\(running\.\.\.\)/);
});

test("an expanded parallel batch renders every child's report as markdown", () => {
  const reported = (text: string) => child({ task: text, messages: [said(text)] });

  const nodes = describeResult(spawnResult(parallel(reported("first"), reported("second"))), true, plainTheme);

  assert.deepEqual(
    nodes.filter((n) => n.kind === "markdown").map((n) => (n.kind === "markdown" ? n.text : "")),
    ["first", "second"],
  );
});

test("a single call previews the task it was given", () => {
  const nodes = describeCall({ task: "refactor the parser" }, plainTheme);

  assert.equal(shown(nodes), "spawn single\n  refactor the parser");
});

test("a parallel call previews the first three tasks and counts the rest", () => {
  const tasks = ["a", "b", "c", "d"].map((task) => ({ task }));

  const nodes = describeCall({ tasks }, plainTheme);

  assert.match(shown(nodes), /spawn parallel \(4 tasks\)/);
  assert.match(shown(nodes), /\n {2}a\n {2}b\n {2}c\n {2}\.\.\. \+1 more/);
});
