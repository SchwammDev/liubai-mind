import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { CLARIFY_TAG, type ComplexityMap } from "./child.ts";
import { DialogGate } from "./bridge.ts";
import { __resetClarifyState, type ToolResult } from "./clarify.ts";
import { runSpawn, type SpawnContext, type TransportFactory } from "./orchestrate.ts";
import { FakeTransport } from "./testing.ts";

const MODELS: ComplexityMap = { trivial: "tiny", easy: "small", medium: "mid", hard: "big" };

const silentContext = (): SpawnContext => ({
  cwd: "/repo",
  hasUI: false,
  ui: {
    confirm: () => Promise.resolve(true),
    select: () => Promise.resolve(undefined),
    input: () => Promise.resolve(undefined),
    editor: () => Promise.resolve(undefined),
    notify: () => {},
  },
});

class SpawnedChildren {
  readonly spawns: Array<{ model: string; depthEnv: string; transport: FakeTransport; stderr: (s: string) => void }> =
    [];

  readonly factory: TransportFactory = (_cwd, model, depthEnv, onStderr) => {
    const transport = new FakeTransport();
    this.spawns.push({ model, depthEnv, transport, stderr: onStderr });
    return transport;
  };

  at(index: number) {
    const spawned = this.spawns[index];
    assert.ok(spawned, `expected a child at index ${index}, only ${this.spawns.length} were spawned`);
    return spawned;
  }

  get models() {
    return this.spawns.map((s) => s.model);
  }
}

const spawning = (
  params: Parameters<typeof runSpawn>[2],
  options: { children?: SpawnedChildren; loadComplexity?: () => ComplexityMap; onUpdate?: (u: ToolResult) => void } = {},
) => {
  const children = options.children ?? new SpawnedChildren();
  const result = runSpawn(
    { spawnTransport: children.factory, loadComplexity: options.loadComplexity ?? (() => MODELS) },
    silentContext(),
    params,
    undefined,
    options.onUpdate,
    new DialogGate(),
  );
  return { children, result };
};

const answering = (text: string) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], model: "m", stopReason: "end", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } } } });

const settling = () => JSON.stringify({ type: "agent_settled" });

const askingClarify = (id: string, question: string) =>
  JSON.stringify({ type: "extension_ui_request", id, method: "input", title: CLARIFY_TAG + question });

const textOf = (result: ToolResult) => result.content.map((c) => c.text).join("");

beforeEach(__resetClarifyState);
afterEach(__resetClarifyState);

test("a task without a complexity is rejected before any child is spawned", async () => {
  const { children, result } = spawning({ task: "do it" });

  const spawn = await result;

  assert.match(textOf(spawn), /complexity is required/);
  assert.equal(children.spawns.length, 0);
  assert.equal(spawn.isError, undefined);
});

test("an unreadable complexity config fails the spawn loudly", async () => {
  const { children, result } = spawning(
    { task: "do it", complexity: "medium" },
    {
      loadComplexity: () => {
        throw new Error("Complexity config at ~/.pi/agent/complexity.json is missing");
      },
    },
  );

  const spawn = await result;

  assert.equal(spawn.isError, true);
  assert.match(textOf(spawn), /Complexity config .* is missing/);
  assert.equal(children.spawns.length, 0);
});

test("a settled child reports its final answer", async () => {
  const { children, result } = spawning({ task: "do it", complexity: "medium" });

  children.at(0).transport.emitLine(answering("the answer"));
  children.at(0).transport.emitLine(settling());

  assert.equal(textOf(await result), "the answer");
});

test("the child is spawned on the model its complexity maps to", async () => {
  const { children, result } = spawning({ task: "do it", complexity: "hard" });

  children.at(0).transport.emitLine(settling());
  await result;

  assert.deepEqual(children.models, ["big"]);
});

test("the child runs one level below its parent", async () => {
  const { children, result } = spawning({ task: "do it", complexity: "easy" });

  children.at(0).transport.emitLine(settling());
  await result;

  assert.equal(children.at(0).depthEnv, "1");
});

test("what the child wrote to stderr is kept on the result", async () => {
  const { children, result } = spawning({ task: "do it", complexity: "easy" });

  children.at(0).stderr("permission denied\n");
  children.at(0).transport.emitLine(settling());

  const [child] = (await result).details.results;
  assert.equal(child?.stderr, "permission denied\n");
});

test("the child session is torn down once its report is in", async () => {
  const { children, result } = spawning({ task: "do it", complexity: "easy" });

  children.at(0).transport.emitLine(answering("done"));
  children.at(0).transport.emitLine(settling());
  await result;

  assert.equal(children.at(0).transport.killed, true);
});

test("a child that exits before completing its turn is reported as an error", async () => {
  const { children, result } = spawning({ task: "do it", complexity: "easy" });

  children.at(0).transport.emitClose(3);

  const spawn = await result;
  assert.equal(spawn.isError, true);
  assert.match(textOf(spawn), /child exited \(code 3\) before completing its turn/);
});

test("a child asking a clarifying question suspends the spawn instead of reporting", async () => {
  const { children, result } = spawning({ task: "do it", complexity: "easy" });

  children.at(0).transport.emitLine(askingClarify("q1", "which file?"));

  const spawn = await result;
  assert.match(textOf(spawn), /Child asks: which file\?/);
  assert.equal(children.at(0).transport.killed, false);
});

test("a second spawn is refused while a child awaits an answer", async () => {
  const first = spawning({ task: "do it", complexity: "easy" });
  first.children.at(0).transport.emitLine(askingClarify("q1", "which file?"));
  await first.result;

  const second = await spawning({ task: "something else", complexity: "easy" }).result;

  assert.equal(second.isError, true);
  assert.match(textOf(second), /awaiting an answer/);
});

test("every parallel task is spawned on the model its own complexity maps to", async () => {
  const { children, result } = spawning({
    tasks: [
      { task: "a", complexity: "trivial" },
      { task: "b", complexity: "hard" },
    ],
  });

  children.at(0).transport.emitLine(settling());
  children.at(1).transport.emitLine(settling());
  await result;

  assert.deepEqual(children.models, ["tiny", "big"]);
});

test("progress is reported as each parallel child settles", async () => {
  const updates: ToolResult[] = [];
  const { children, result } = spawning(
    {
      tasks: [
        { task: "a", complexity: "easy" },
        { task: "b", complexity: "easy" },
      ],
    },
    { onUpdate: (u) => updates.push(u) },
  );

  children.at(0).transport.emitLine(settling());
  children.at(1).transport.emitLine(settling());
  await result;

  assert.match(textOf(updates.at(-1)!), /Parallel: 2\/2 done, 0 running/);
  assert.ok(
    updates.some((u) => /Parallel: 1\/2 done, 1 running/.test(textOf(u))),
    "expected an update while one child was still running",
  );
});

test("the parallel summary carries one section per task with its status", async () => {
  const { children, result } = spawning({
    tasks: [
      { task: "first task", complexity: "easy" },
      { task: "second task", complexity: "easy" },
    ],
  });

  children.at(0).transport.emitLine(answering("first done"));
  children.at(0).transport.emitLine(settling());
  children.at(1).transport.emitClose(1);

  const text = textOf(await result);
  assert.match(text, /### \[first task\] completed\n\nfirst done/);
  assert.match(text, /### \[second task\] failed/);
});

test("only the parallel children that succeeded are counted", async () => {
  const { children, result } = spawning({
    tasks: [
      { task: "a", complexity: "easy" },
      { task: "b", complexity: "easy" },
    ],
  });

  children.at(0).transport.emitLine(settling());
  children.at(1).transport.emitClose(1);

  assert.match(textOf(await result), /Parallel: 1\/2 succeeded/);
});

test("a parallel batch reports every task in its details", async () => {
  const { children, result } = spawning({
    tasks: [
      { task: "a", complexity: "easy" },
      { task: "b", complexity: "easy" },
    ],
  });

  children.at(0).transport.emitLine(settling());
  children.at(1).transport.emitLine(settling());

  const spawn = await result;
  assert.equal(spawn.details.mode, "parallel");
  assert.deepEqual(
    spawn.details.results.map((r) => r.task),
    ["a", "b"],
  );
});
