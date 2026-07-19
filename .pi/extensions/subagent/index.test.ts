import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  selectMode,
  loadComplexityMap,
  aggregateUsage,
  getFinalOutput,
  getResultOutput,
  MAX_PARALLEL_TASKS,
  REPORT_CAP,
  assessReport,
  gateReport,
  compressPrompt,
  truncationNotice,
  canSpawn,
  childDepthOf,
  currentDepth,
  isFailedResult,
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

test("a lone task with a complexity selects single mode", () => {
  const selection = selectMode({ task: "summarize the changelog", complexity: "easy" });

  assert.deepEqual(selection, { kind: "single" });
});

test("a tasks array with complexities selects parallel mode", () => {
  const selection = selectMode({
    tasks: [
      { task: "lint", complexity: "trivial" },
      { task: "typecheck", complexity: "medium" },
    ],
  });

  assert.deepEqual(selection, { kind: "parallel" });
});

test("providing both task and tasks is rejected as ambiguous", () => {
  const selection = selectMode({ task: "one", complexity: "easy", tasks: [{ task: "two", complexity: "easy" }] });

  assert.equal(selection.kind, "error");
});

test("providing neither task nor tasks is rejected", () => {
  const selection = selectMode({});

  assert.equal(selection.kind, "error");
});

test("more parallel tasks than the cap are rejected", () => {
  const tooMany = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({
    task: `task ${i}`,
    complexity: "easy",
  }));

  const selection = selectMode({ tasks: tooMany });

  assert.equal(selection.kind, "error");
});

test("a single task without a complexity is rejected", () => {
  const selection = selectMode({ task: "summarize the changelog" });

  assert.equal(selection.kind, "error");
});

test("an unknown complexity value is rejected", () => {
  const selection = selectMode({ task: "summarize the changelog", complexity: "impossible" });

  assert.equal(selection.kind, "error");
});

test("a parallel task item without a complexity is rejected", () => {
  const selection = selectMode({ tasks: [{ task: "lint", complexity: "easy" }, { task: "typecheck" }] });

  assert.equal(selection.kind, "error");
});

const complexityConfigFile = (contents: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "complexity-"));
  const file = path.join(dir, "complexity.json");
  fs.writeFileSync(file, contents);
  return file;
};

const FULL_TIER_MAP = { trivial: "t-model", easy: "e-model", medium: "m-model", hard: "h-model" };

test("a valid config maps every complexity tier to its model id", () => {
  const file = complexityConfigFile(JSON.stringify(FULL_TIER_MAP));

  const map = loadComplexityMap(file);

  assert.deepEqual(map, FULL_TIER_MAP);
});

test("a missing config file errors naming the path and the example file", () => {
  const missing = path.join(os.tmpdir(), "does-not-exist", "complexity.json");

  assert.throws(() => loadComplexityMap(missing), (e: Error) => {
    assert.match(e.message, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(e.message, /complexity\.example\.json/);
    return true;
  });
});

test("malformed JSON in the config errors naming the path", () => {
  const file = complexityConfigFile("{ not json");

  assert.throws(() => loadComplexityMap(file), (e: Error) => {
    assert.match(e.message, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(e.message, /complexity\.example\.json/);
    return true;
  });
});

test("a config missing a tier is rejected", () => {
  const { hard, ...incomplete } = FULL_TIER_MAP;
  const file = complexityConfigFile(JSON.stringify(incomplete));

  assert.throws(() => loadComplexityMap(file), /hard/);
});

test("a config with an unknown extra key is rejected", () => {
  const file = complexityConfigFile(JSON.stringify({ ...FULL_TIER_MAP, extreme: "x-model" }));

  assert.throws(() => loadComplexityMap(file), /extreme/);
});

test("an empty model id is rejected", () => {
  const file = complexityConfigFile(JSON.stringify({ ...FULL_TIER_MAP, easy: "" }));

  assert.throws(() => loadComplexityMap(file), /easy/);
});

test("a non-string model id is rejected", () => {
  const file = complexityConfigFile(JSON.stringify({ ...FULL_TIER_MAP, medium: 42 }));

  assert.throws(() => loadComplexityMap(file), /medium/);
});

test("a report under the cap is accepted", () => {
  assert.deepEqual(assessReport("short report"), { kind: "accepted" });
});

test("a report exactly at the cap is accepted", () => {
  const at = "x".repeat(REPORT_CAP);

  assert.deepEqual(assessReport(at), { kind: "accepted" });
});

test("a report over the cap needs compress with its byte count", () => {
  const over = "x".repeat(REPORT_CAP + 100);

  assert.deepEqual(assessReport(over), { kind: "needs_compress", bytes: REPORT_CAP + 100 });
});

test("an accepted report passes through the gate without compressing", async () => {
  let calls = 0;
  const compress = async () => {
    calls++;
    return "should not be used";
  };

  const { report, verdict } = await gateReport("fine as is", undefined, compress);

  assert.equal(report, "fine as is");
  assert.deepEqual(verdict, { kind: "accepted" });
  assert.equal(calls, 0);
});

test("an oversized report whose compress lands under cap is returned accepted", async () => {
  let calls = 0;
  const original = "x".repeat(REPORT_CAP + 1);
  const compressed = "fits now";
  const compress = async (report: string) => {
    calls++;
    assert.equal(report, original);
    return compressed;
  };

  const { report, verdict } = await gateReport(original, undefined, compress);

  assert.equal(report, compressed);
  assert.deepEqual(verdict, { kind: "accepted" });
  assert.equal(calls, 1);
});

test("a report still over cap after compress is hard-truncated and flagged", async () => {
  let calls = 0;
  const original = "x".repeat(REPORT_CAP + 1);
  const stillOver = "y".repeat(REPORT_CAP + 50);
  const compress = async (report: string) => {
    calls++;
    assert.equal(report, original);
    return stillOver;
  };

  const { report, verdict } = await gateReport(original, undefined, compress);

  assert.ok(Buffer.byteLength(report, "utf8") <= REPORT_CAP);
  assert.equal(verdict.kind, "truncated");
  if (verdict.kind === "truncated") {
    assert.equal(verdict.bytes, Buffer.byteLength(stillOver, "utf8") - Buffer.byteLength(report, "utf8"));
  }
  assert.equal(calls, 1);
});

test("the truncation notice names the omitted byte count and the cap", () => {
  const notice = truncationNotice(50);

  assert.match(notice, /50 bytes/);
  assert.match(notice, /4 KB/);
});

test("the compress prompt states the 4 KB limit and output-only instruction", () => {
  const prompt = compressPrompt("x".repeat(REPORT_CAP + 1));

  assert.match(prompt, /4 ?KB/);
  assert.match(prompt, /4096/);
  assert.match(prompt, /only/i);
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

test("a child that exits cleanly without settling is a failed result", () => {
  const unsettled = childResult({ exitCode: 0, settled: false });

  assert.equal(isFailedResult(unsettled), true);
});

test("a settled clean exit stays a successful result", () => {
  const settled = childResult({ exitCode: 0, settled: true });

  assert.equal(isFailedResult(settled), false);
});

test("only the top depth may spawn", () => {
  assert.equal(canSpawn(0), true);
  assert.equal(canSpawn(1), false);
  assert.equal(canSpawn(2), false);
});

test("a child sits one level below its parent", () => {
  assert.equal(childDepthOf(0), 1);
  assert.equal(childDepthOf(1), 2);
});

test("a missing or malformed depth falls back to the top", () => {
  const saved = process.env.LIUBAI_SPAWN_DEPTH;
  try {
    delete process.env.LIUBAI_SPAWN_DEPTH;
    assert.equal(currentDepth(), 0);

    process.env.LIUBAI_SPAWN_DEPTH = "abc";
    assert.equal(currentDepth(), 0);

    process.env.LIUBAI_SPAWN_DEPTH = "2";
    assert.equal(currentDepth(), 2);

    process.env.LIUBAI_SPAWN_DEPTH = "-1";
    assert.equal(currentDepth(), 0);
  } finally {
    if (saved === undefined) delete process.env.LIUBAI_SPAWN_DEPTH;
    else process.env.LIUBAI_SPAWN_DEPTH = saved;
  }
});

test("at the capped depth a child may not spawn, but the top may", () => {
  const saved = process.env.LIUBAI_SPAWN_DEPTH;
  try {
    process.env.LIUBAI_SPAWN_DEPTH = "1";
    assert.equal(canSpawn(currentDepth()), false);

    delete process.env.LIUBAI_SPAWN_DEPTH;
    assert.equal(canSpawn(currentDepth()), true);
  } finally {
    if (saved === undefined) delete process.env.LIUBAI_SPAWN_DEPTH;
    else process.env.LIUBAI_SPAWN_DEPTH = saved;
  }
});
