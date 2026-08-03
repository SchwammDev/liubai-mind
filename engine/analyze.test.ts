import { test } from "node:test";
import assert from "node:assert/strict";

import { analyze } from "./analyze.ts";
import type { Env, Extracted, FunctionFacts, Lang, Nudge, RuleName, Rule, RuleContext } from "./contract.ts";
import { RULE } from "./contract.ts";

const APP_PY = "app/foo.py";

const TOUCHED_FUNCTION: FunctionFacts = {
  name: "f",
  startLine: 1,
  endLine: 3,
  cyclomaticComplexity: 9,
  missingAnnotations: ["x"],
  isTest: false,
  bodyLineCount: 2,
  signature: "changed",
  body: "changed",
};

const ENV: Env = {};

function pythonExtractor(extract: () => Extracted | Promise<Extracted>): Env {
  return { extractors: { python: { extract } } };
}

const FACTS_ENV: Env = pythonExtractor(() => ({ functions: [TOUCHED_FUNCTION], comments: [] }));

function extractorThatThrows(error: Error): Env {
  return pythonExtractor(() => { throw error; });
}

function nudge(rule: RuleName, msg: string, severity: Nudge["severity"], line?: number): Nudge {
  const out: Nudge = { rule, msg, severity };
  if (line !== undefined) out.line = line;
  return out;
}

function ruleReturning(run: Rule["run"], name = "rule"): Rule {
  return { name, run };
}

function factsSeenBy(seen: Extracted[]): Rule {
  return { name: "snoop", run: (ctx) => { seen.push(ctx.extracted); return []; } };
}

function contextSeenBy(seen: RuleContext[]): Rule {
  return { name: "capture", run: (ctx) => { seen.push(ctx); return []; } };
}

function firstOrFail<T>(items: readonly T[], message: string): T {
  const first = items[0];
  if (first === undefined) assert.fail(message);
  return first;
}

function assertContextCarries(
  ctx: RuleContext,
  expected: { path: string; lang: Lang; after: string; before: string; env: Env },
): void {
  assert.equal(ctx.path, expected.path);
  assert.equal(ctx.lang, expected.lang);
  assert.equal(ctx.after, expected.after);
  assert.equal(ctx.before, expected.before);
  assert.equal(ctx.env, expected.env);
  assert.deepEqual(ctx.extracted, { functions: [], comments: [] });
}

test("a req.lang override beats path-based detection", async () => {
  const rule = ruleReturning((ctx) => [nudge(RULE.cc, ctx.lang, "nudge")]);

  const resp = await analyze({ path: "app/foo.md", after: "", lang: "python" }, ENV, [rule]);

  assert.deepEqual(resp.nudges, [{ rule: RULE.cc, msg: "python", severity: "nudge" }]);
});

test("an unknown extension yields an empty response", async () => {
  const resp = await analyze({ path: "README.md", after: "" }, ENV, [ruleReturning(() => [nudge(RULE.cc, "x", "nudge")])]);

  assert.deepEqual(resp, { nudges: [], errors: [] });
});

test("a skipped path segment yields an empty response", async () => {
  const resp = await analyze({ path: "db/migrations/0001.py", after: "" }, ENV, [ruleReturning(() => [nudge(RULE.cc, "x", "nudge")])]);

  assert.deepEqual(resp, { nudges: [], errors: [] });
});

test("a generated header yields an empty response", async () => {
  const resp = await analyze({ path: APP_PY, after: "@generated\nx = 1" }, ENV, [ruleReturning(() => [nudge(RULE.cc, "x", "nudge")])]);

  assert.deepEqual(resp, { nudges: [], errors: [] });
});

test("nudges pass through intact including severity and line", async () => {
  const rule = ruleReturning(() => [nudge(RULE.discourageComments, "watch out", "block", 7)]);

  const resp = await analyze({ path: APP_PY, after: "x = 1" }, ENV, [rule]);

  assert.deepEqual(resp.nudges, [{ rule: RULE.discourageComments, msg: "watch out", severity: "block", line: 7 }]);
});

test("an async rule is awaited before its nudges return", async () => {
  const rule = ruleReturning(async () => { await Promise.resolve(); return [nudge(RULE.cc, "done", "nudge")]; });

  const resp = await analyze({ path: APP_PY, after: "x = 1" }, ENV, [rule]);

  assert.deepEqual(resp.nudges, [{ rule: RULE.cc, msg: "done", severity: "nudge" }]);
});

test("a throwing rule yields an error naming the rule while later rules still nudge", async () => {
  const boom = ruleReturning(() => { throw new Error("nope"); }, "boom");
  const ok = ruleReturning(() => [nudge(RULE.cc, "fine", "nudge")], "ok");

  const resp = await analyze({ path: APP_PY, after: "x = 1" }, ENV, [boom, ok]);

  assert.deepEqual(resp.errors, [{ source: "boom", msg: "Error: nope" }]);
  assert.deepEqual(resp.nudges, [{ rule: RULE.cc, msg: "fine", severity: "nudge" }]);
});

test("rules receive a context carrying before after env and lang", async () => {
  const seen: RuleContext[] = [];

  await analyze({ path: "app/foo.ts", after: "after-text", before: "before-text", lang: "typescript" }, ENV, [contextSeenBy(seen)]);

  assertContextCarries(firstOrFail(seen, "rule was never run"), {
    path: "app/foo.ts", lang: "typescript", after: "after-text", before: "before-text", env: ENV,
  });
});

test("an extractor's facts reach the rule context", async () => {
  const seen: Extracted[] = [];

  await analyze({ path: APP_PY, after: "def f():\n  pass" }, FACTS_ENV, [factsSeenBy(seen)]);

  const fn = firstOrFail(firstOrFail(seen, "rule was never run").functions, "expected one function fact");
  assert.equal(fn.name, "f");
  assert.equal(fn.cyclomaticComplexity, 9);
});

test("a lang with no registered extractor yields empty facts", async () => {
  const seen: Extracted[] = [];

  await analyze({ path: "src/main.cpp", after: "int main(){}" }, FACTS_ENV, [factsSeenBy(seen)]);

  assert.deepEqual(seen[0], { functions: [], comments: [] });
});

test("a failing extractor is reported as an error and rules still run on empty facts", async () => {
  const seen: Extracted[] = [];

  const resp = await analyze({ path: APP_PY, after: "x = '" }, extractorThatThrows(new SyntaxError("unterminated string")), [factsSeenBy(seen)]);

  assert.deepEqual(resp.errors, [{ source: "extract:python", msg: "SyntaxError: unterminated string" }]);
  assert.deepEqual(seen[0], { functions: [], comments: [] });
});

test("an async extractor is awaited before rules see its facts", async () => {
  const seen: Extracted[] = [];
  const env = pythonExtractor(async () => { await Promise.resolve(); return { functions: [TOUCHED_FUNCTION], comments: [] }; });

  await analyze({ path: APP_PY, after: "def f():\n  pass" }, env, [factsSeenBy(seen)]);

  assert.deepEqual(seen[0], { functions: [TOUCHED_FUNCTION], comments: [] });
});

test("two identical calls produce deep-equal responses (determinism)", async () => {
  const rule = ruleReturning((ctx) => [nudge(RULE.cc, ctx.after, "nudge")]);
  const req = { path: APP_PY, after: "x = 1" };

  const a = await analyze(req, ENV, [rule]);
  const b = await analyze(req, ENV, [rule]);

  assert.deepEqual(a, b);
});
