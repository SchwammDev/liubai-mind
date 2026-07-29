import { test } from "node:test";
import assert from "node:assert/strict";

import { analyze } from "./analyze.ts";
import type { Env, Extracted, FunctionFacts, Nudge, RuleName, Rule, RuleContext } from "./contract.ts";
import { RULE } from "./contract.ts";

const TOUCHED_FUNCTION: FunctionFacts = {
  name: "f",
  startLine: 1,
  cyclomaticComplexity: 9,
  missingAnnotations: ["x"],
  isTest: false,
  bodyLineCount: 2,
  signature: "changed",
  body: "changed",
};

const FACTS_ENV: Env = {
  extractors: {
    python: { extract: () => ({ functions: [TOUCHED_FUNCTION], comments: [] }) },
  },
};

const ENV: Env = {};

function nudge(rule: RuleName, msg: string, severity: Nudge["severity"], line?: number): Nudge {
  const out: Nudge = { rule, msg, severity };
  if (line !== undefined) out.line = line;
  return out;
}

function factsSeenBy(seen: Extracted[]): Rule {
  return { name: "snoop", run: (ctx) => { seen.push(ctx.extracted); return []; } };
}

test("a req.lang override beats path-based detection", async () => {
  const rule: Rule = {
    name: "witness",
    run: (ctx) => [nudge(RULE.cc, ctx.lang, "nudge")],
  };

  const resp = await analyze({ path: "app/foo.md", after: "", lang: "python" }, ENV, [rule]);

  assert.deepEqual(resp.nudges, [{ rule: RULE.cc, msg: "python", severity: "nudge" }]);
});

test("an unknown extension yields an empty response", async () => {
  const rule: Rule = { name: "snoop", run: () => [nudge(RULE.cc, "x", "nudge")] };

  const resp = await analyze({ path: "README.md", after: "" }, ENV, [rule]);

  assert.deepEqual(resp, { nudges: [], errors: [] });
});

test("a skipped path segment yields an empty response", async () => {
  const rule: Rule = { name: "snoop", run: () => [nudge(RULE.cc, "x", "nudge")] };

  const resp = await analyze({ path: "db/migrations/0001.py", after: "" }, ENV, [rule]);

  assert.deepEqual(resp, { nudges: [], errors: [] });
});

test("a generated header yields an empty response", async () => {
  const rule: Rule = { name: "snoop", run: () => [nudge(RULE.cc, "x", "nudge")] };

  const resp = await analyze({ path: "app/foo.py", after: "@generated\nx = 1" }, ENV, [rule]);

  assert.deepEqual(resp, { nudges: [], errors: [] });
});

test("nudges pass through intact including severity and line", async () => {
  const rule: Rule = {
    name: "lined",
    run: () => [nudge(RULE.discourageComments, "watch out", "block", 7)],
  };

  const resp = await analyze({ path: "app/foo.py", after: "x = 1" }, ENV, [rule]);

  assert.deepEqual(resp.nudges, [{ rule: RULE.discourageComments, msg: "watch out", severity: "block", line: 7 }]);
});

test("an async rule is awaited before its nudges return", async () => {
  const rule: Rule = {
    name: "slow",
    run: async () => {
      await Promise.resolve();
      return [nudge(RULE.cc, "done", "nudge")];
    },
  };

  const resp = await analyze({ path: "app/foo.py", after: "x = 1" }, ENV, [rule]);

  assert.deepEqual(resp.nudges, [{ rule: RULE.cc, msg: "done", severity: "nudge" }]);
});

test("a throwing rule yields an error naming the rule while later rules still nudge", async () => {
  const boom: Rule = { name: "boom", run: () => { throw new Error("nope"); } };
  const ok: Rule = { name: "ok", run: () => [nudge(RULE.cc, "fine", "nudge")] };

  const resp = await analyze({ path: "app/foo.py", after: "x = 1" }, ENV, [boom, ok]);

  assert.deepEqual(resp.errors, [{ source: "boom", msg: "Error: nope" }]);
  assert.deepEqual(resp.nudges, [{ rule: RULE.cc, msg: "fine", severity: "nudge" }]);
});

test("rules receive a context carrying before after env and lang", async () => {
  const seen: RuleContext[] = [];
  const rule: Rule = {
    name: "capture",
    run: (ctx) => { seen.push(ctx); return []; },
  };

  await analyze(
    { path: "app/foo.ts", after: "after-text", before: "before-text", lang: "typescript" },
    ENV,
    [rule],
  );

  const got = seen[0];
  if (got === undefined) { assert.fail("rule was never run"); return; }

  assert.equal(got.path, "app/foo.ts");
  assert.equal(got.lang, "typescript");
  assert.equal(got.after, "after-text");
  assert.equal(got.before, "before-text");
  assert.equal(got.env, ENV);
  assert.deepEqual(got.extracted, { functions: [], comments: [] });
});

test("an extractor's facts reach the rule context", async () => {
  const seen: Extracted[] = [];
  const rule: Rule = factsSeenBy(seen);

  await analyze({ path: "app/foo.py", after: "def f():\n  pass" }, FACTS_ENV, [rule]);

  assert.equal(seen.length, 1);
  const got = seen[0];
  if (got === undefined) { assert.fail("rule was never run"); return; }
  const fn = got.functions[0];
  if (fn === undefined) { assert.fail("expected one function fact"); return; }
  assert.equal(fn.name, "f");
  assert.equal(fn.cyclomaticComplexity, 9);
});

test("a lang with no registered extractor yields empty facts", async () => {
  const seen: Extracted[] = [];
  const rule: Rule = factsSeenBy(seen);

  await analyze({ path: "src/main.cpp", after: "int main(){}" }, FACTS_ENV, [rule]);

  assert.deepEqual(seen[0], { functions: [], comments: [] });
});

test("a failing extractor is reported as an error and rules still run on empty facts", async () => {
  const env: Env = {
    extractors: { python: { extract: () => { throw new SyntaxError("unterminated string"); } } },
  };
  const seen: Extracted[] = [];

  const resp = await analyze({ path: "app/foo.py", after: "x = '" }, env, [factsSeenBy(seen)]);

  assert.deepEqual(resp.errors, [{ source: "extract:python", msg: "SyntaxError: unterminated string" }]);
  assert.deepEqual(seen[0], { functions: [], comments: [] });
});

test("an async extractor is awaited before rules see its facts", async () => {
  const env: Env = {
    extractors: {
      python: {
        extract: async () => {
          await Promise.resolve();
          return { functions: [TOUCHED_FUNCTION], comments: [] };
        },
      },
    },
  };
  const seen: Extracted[] = [];

  await analyze({ path: "app/foo.py", after: "def f():\n  pass" }, env, [factsSeenBy(seen)]);

  assert.deepEqual(seen[0], { functions: [TOUCHED_FUNCTION], comments: [] });
});

test("two identical calls produce deep-equal responses (determinism)", async () => {
  const rule: Rule = {
    name: "det",
    run: (ctx) => [nudge(RULE.cc, ctx.after, "nudge")],
  };
  const req = { path: "app/foo.py", after: "x = 1" };

  const a = await analyze(req, ENV, [rule]);
  const b = await analyze(req, ENV, [rule]);

  assert.deepEqual(a, b);
});
