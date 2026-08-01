import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { CLARIFY_TAG, type Complexity, type ComplexitySelection, type ComplexityMap } from "./child.ts";
import { DialogGate } from "./bridge.ts";
import { ClarifyStore, type ToolResult } from "./clarify.ts";
import { runSpawn, type SpawnContext, type SpawnParams, type TransportFactory } from "./orchestrate.ts";
import { FakeTransport } from "./testing.ts";
import type { CatalogModel, ModelCatalog } from "./tier-model.ts";

const MODELS: ComplexityMap = { trivial: "gw/tiny", easy: "gw/small", medium: "gw/mid", hard: "gw/big" };

const entry = (provider: string, id: string): CatalogModel => ({ provider, id, api: "openai-responses" });

const CATALOG_ENTRIES = [
  entry("gw", "tiny"),
  entry("gw", "small"),
  entry("gw", "mid"),
  entry("gw", "big"),
  entry("offgrid", "big"),
  entry("unpaid", "big"),
];

const SEARCHING_PROVIDERS = ["gw", "unpaid"];
const CREDENTIALLED_PROVIDERS = ["gw", "offgrid"];

const catalog: ModelCatalog = {
  find: (provider, modelId) => CATALOG_ENTRIES.find((m) => m.provider === provider && m.id === modelId),
  getAll: () => [...CATALOG_ENTRIES],
  hasConfiguredAuth: (model) => CREDENTIALLED_PROVIDERS.includes(model.provider),
};

const silentContext = (): SpawnContext => ({
  cwd: "/repo",
  hasUI: false,
  modelRegistry: catalog,
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

let sharedStore = new ClarifyStore();
afterEach(() => { sharedStore.reset(); sharedStore = new ClarifyStore(); });

const spawning = (
  params: Parameters<typeof runSpawn>[2],
  options: { children?: SpawnedChildren; loadComplexity?: () => ComplexitySelection; onUpdate?: (u: ToolResult) => void } = {},
) => {
  const children = options.children ?? new SpawnedChildren();
  const store = sharedStore;
  const result = runSpawn(
    {
      spawnTransport: children.factory,
      store,
      loadComplexity: options.loadComplexity ?? (() => ({ profile: "default", map: MODELS })),
      loadWebSearch: () => ({ providers: SEARCHING_PROVIDERS }),
    },
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

type SpawnTask = { task: string; complexity: Complexity };
type Child = ReturnType<SpawnedChildren["at"]>;

const parallel = (...tasks: SpawnTask[]): SpawnParams => ({ tasks });

const TWO_EASY_TASKS = parallel({ task: "a", complexity: "easy" }, { task: "b", complexity: "easy" });

const throwing = (message: string) => (): ComplexitySelection => {
  throw new Error(message);
};

const hardTier = (model: string) => (): ComplexitySelection => ({ profile: "default", map: { ...MODELS, hard: model } });

const profileNamed = (profile: string) => (): ComplexitySelection => ({ profile, map: MODELS });

const settle = (child: Child) => child.transport.emitLine(settling());

const settleAll = (children: SpawnedChildren, count: number) => {
  for (let index = 0; index < count; index++) settle(children.at(index));
};

const answerAndSettle = (child: Child, text: string) => {
  child.transport.emitLine(answering(text));
  settle(child);
};

const crash = (child: Child, exitCode: number) => child.transport.emitClose(exitCode);

const recordingUpdates = () => {
  const updates: ToolResult[] = [];
  return { updates, onUpdate: (update: ToolResult) => updates.push(update) };
};

const settledFirstResult = async (params: SpawnParams, options: Parameters<typeof spawning>[1]) => {
  const { children, result } = spawning(params, options);
  settle(children.at(0));
  const [child] = (await result).details.results;
  return child;
};

const withoutSpawnDepth = async (body: () => Promise<void>) => {
  const saved = process.env.LIUBAI_SPAWN_DEPTH;
  delete process.env.LIUBAI_SPAWN_DEPTH;
  try {
    await body();
  } finally {
    if (saved === undefined) delete process.env.LIUBAI_SPAWN_DEPTH;
    else process.env.LIUBAI_SPAWN_DEPTH = saved;
  }
};

const assertSpawnFailedWith = (spawn: ToolResult, children: SpawnedChildren, pattern: RegExp) => {
  assert.equal(spawn.isError, true);
  assert.match(textOf(spawn), pattern);
  assert.equal(children.spawns.length, 0);
};

const assertMatchesAll = (text: string, ...patterns: RegExp[]) => {
  for (const pattern of patterns) assert.match(text, pattern);
};

const assertLastUpdate = (updates: ToolResult[], pattern: RegExp) => assert.match(textOf(updates.at(-1)!), pattern);

const assertSomeUpdate = (updates: ToolResult[], pattern: RegExp, why: string) =>
  assert.ok(updates.some((update) => pattern.test(textOf(update))), why);

const assertParallelTasks = (spawn: ToolResult, tasks: string[]) => {
  assert.equal(spawn.details.mode, "parallel");
  assert.deepEqual(spawn.details.results.map((r) => r.task), tasks);
};

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
    { loadComplexity: throwing("Complexity config at ~/.pi/agent/complexity.json is missing") },
  );

  assertSpawnFailedWith(await result, children, /Complexity config .* is missing/);
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

  assert.deepEqual(children.models, ["gw/big"]);
});

test("a tier whose model id lacks a provider prefix fails the spawn before any child starts", async () => {
  const { children, result } = spawning(
    { task: "do it", complexity: "hard" },
    { loadComplexity: hardTier("big") },
  );

  assertSpawnFailedWith(await result, children, /"hard".*provider prefix/s);
});

test("a tier outside the web-search allowlist still runs, carrying the loss as a note", async () => {
  const child = await settledFirstResult(
    { task: "do it", complexity: "hard" },
    { loadComplexity: hardTier("offgrid/big") },
  );

  assert.deepEqual(child?.notes, ['no web search — provider "offgrid" is not in the web-search allowlist']);
});

test("a tier whose provider has no configured credentials still runs, carrying that as a note", async () => {
  const child = await settledFirstResult(
    { task: "do it", complexity: "hard" },
    { loadComplexity: hardTier("unpaid/big") },
  );

  assert.deepEqual(child?.notes, ['no configured credentials for provider "unpaid"']);
});

test("a spawn surfaces the active profile name on each child result", async () => {
  const child = await settledFirstResult(
    { task: "do it", complexity: "easy" },
    { loadComplexity: profileNamed("nightly") },
  );

  assert.equal(child?.profile, "nightly");
});

test("the child runs one level below its parent", async () => {
  await withoutSpawnDepth(async () => {
    const { children, result } = spawning({ task: "do it", complexity: "easy" });

    settle(children.at(0));
    await result;

    assert.equal(children.at(0).depthEnv, "1");
  });
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
  const { children, result } = spawning(parallel({ task: "a", complexity: "trivial" }, { task: "b", complexity: "hard" }));

  settleAll(children, 2);
  await result;

  assert.deepEqual(children.models, ["gw/tiny", "gw/big"]);
});

test("progress is reported as each parallel child settles", async () => {
  const progress = recordingUpdates();
  const { children, result } = spawning(TWO_EASY_TASKS, { onUpdate: progress.onUpdate });

  settleAll(children, 2);
  await result;

  assertLastUpdate(progress.updates, /Parallel: 2\/2 done, 0 running/);
  assertSomeUpdate(progress.updates, /Parallel: 1\/2 done, 1 running/, "expected an update while one child was still running");
});

test("the parallel summary carries one section per task with its status", async () => {
  const { children, result } = spawning(parallel({ task: "first task", complexity: "easy" }, { task: "second task", complexity: "easy" }));

  answerAndSettle(children.at(0), "first done");
  crash(children.at(1), 1);

  assertMatchesAll(textOf(await result), /### \[first task\] completed\n\nfirst done/, /### \[second task\] failed/);
});

test("only the parallel children that succeeded are counted", async () => {
  const { children, result } = spawning(TWO_EASY_TASKS);

  settle(children.at(0));
  crash(children.at(1), 1);

  assert.match(textOf(await result), /Parallel: 1\/2 succeeded/);
});

test("a parallel batch reports every task in its details", async () => {
  const { children, result } = spawning(TWO_EASY_TASKS);

  settleAll(children, 2);

  assertParallelTasks(await result, ["a", "b"]);
});
