import { test } from "node:test";
import assert from "node:assert/strict";

import { analyze } from "./analyze.ts";
import type { Env, Nudge, Rule, RuleContext } from "./contract.ts";

const ENV: Env = {};

function nudge(rule: string, msg: string, severity: Nudge["severity"], line?: number): Nudge {
  const out: Nudge = { rule, msg, severity };
  if (line !== undefined) out.line = line;
  return out;
}

test("a req.lang override beats path-based detection", async () => {
  const rule: Rule = {
    name: "witness",
    run: (ctx) => [nudge(ctx.lang, "lang", "nudge")],
  };

  const resp = await analyze({ path: "app/foo.md", after: "", lang: "python" }, ENV, [rule]);

  assert.deepEqual(resp.nudges, [{ rule: "python", msg: "lang", severity: "nudge" }]);
});

test("an unknown extension yields an empty response", async () => {
  const rule: Rule = { name: "snoop", run: () => [nudge("snoop", "x", "nudge")] };

  const resp = await analyze({ path: "README.md", after: "" }, ENV, [rule]);

  assert.deepEqual(resp, { nudges: [], errors: [] });
});

test("a skipped path segment yields an empty response", async () => {
  const rule: Rule = { name: "snoop", run: () => [nudge("snoop", "x", "nudge")] };

  const resp = await analyze({ path: "db/migrations/0001.py", after: "" }, ENV, [rule]);

  assert.deepEqual(resp, { nudges: [], errors: [] });
});

test("a generated header yields an empty response", async () => {
  const rule: Rule = { name: "snoop", run: () => [nudge("snoop", "x", "nudge")] };

  const resp = await analyze({ path: "app/foo.py", after: "@generated\nx = 1" }, ENV, [rule]);

  assert.deepEqual(resp, { nudges: [], errors: [] });
});

test("nudges pass through intact including severity and line", async () => {
  const rule: Rule = {
    name: "lined",
    run: () => [nudge("lined", "watch out", "block", 7)],
  };

  const resp = await analyze({ path: "app/foo.py", after: "x = 1" }, ENV, [rule]);

  assert.deepEqual(resp.nudges, [{ rule: "lined", msg: "watch out", severity: "block", line: 7 }]);
});

test("an async rule is awaited before its nudges return", async () => {
  const rule: Rule = {
    name: "slow",
    run: async () => {
      await Promise.resolve();
      return [nudge("slow", "done", "nudge")];
    },
  };

  const resp = await analyze({ path: "app/foo.py", after: "x = 1" }, ENV, [rule]);

  assert.deepEqual(resp.nudges, [{ rule: "slow", msg: "done", severity: "nudge" }]);
});

test("a throwing rule yields an error naming the rule while later rules still nudge", async () => {
  const boom: Rule = { name: "boom", run: () => { throw new Error("nope"); } };
  const ok: Rule = { name: "ok", run: () => [nudge("ok", "fine", "nudge")] };

  const resp = await analyze({ path: "app/foo.py", after: "x = 1" }, ENV, [boom, ok]);

  assert.deepEqual(resp.errors, [{ source: "boom", msg: "Error: nope" }]);
  assert.deepEqual(resp.nudges, [{ rule: "ok", msg: "fine", severity: "nudge" }]);
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
});

test("two identical calls produce deep-equal responses (determinism)", async () => {
  const rule: Rule = {
    name: "det",
    run: (ctx) => [nudge("det", ctx.after, "nudge")],
  };
  const req = { path: "app/foo.py", after: "x = 1" };

  const a = await analyze(req, ENV, [rule]);
  const b = await analyze(req, ENV, [rule]);

  assert.deepEqual(a, b);
});
