import { test } from "node:test";
import assert from "node:assert/strict";

import { analyze } from "./analyze.ts";
import type { Env, Extracted, FunctionFacts, Lang, RuleConfig } from "./contract.ts";
import { buildRules, DEFAULT_POLICY, RULE } from "./policy.ts";

function envWith(extracted: Extracted): Env {
  return {
    extractors: {
      python: { extract: () => extracted },
      typescript: { extract: () => extracted },
      cpp: { extract: () => extracted },
    },
  };
}

function func(over: Partial<FunctionFacts>): FunctionFacts {
  return {
    id: over.name ?? "f",
    name: over.name ?? "f",
    startLine: over.startLine ?? 1,
    endLine: over.endLine ?? 3,
    cyclomaticComplexity: over.cyclomaticComplexity ?? 1,
    missingAnnotations: over.missingAnnotations ?? [],
    isTest: over.isTest ?? false,
    bodyLineCount: over.bodyLineCount ?? 2,
    signatureChanged: over.signatureChanged ?? false,
    bodyChanged: over.bodyChanged ?? false,
  };
}

test("buildRules emits the cc rule only for langs in its enabled set", () => {
  const py = buildRules(DEFAULT_POLICY, "python");
  const ts = buildRules(DEFAULT_POLICY, "typescript");

  assert.ok(py.some((r) => r.name === RULE.cc));
  assert.ok(ts.some((r) => r.name === RULE.cc));
});

test("buildRules omits type-annotation for non-gradual langs", () => {
  const cpp = buildRules(DEFAULT_POLICY, "cpp");

  assert.ok(!cpp.some((r) => r.name === RULE.typeAnnotation));
});

test("a custom policy with cc disabled for a lang yields no cc rule", () => {
  const policy = {
    ...DEFAULT_POLICY,
    [RULE.cc]: { ...(DEFAULT_POLICY[RULE.cc] as RuleConfig), enabled: ["python"] as Lang[] },
  };

  assert.ok(buildRules(policy, "typescript").some((r) => r.name === RULE.cc) === false);
});

test("the cc rule nudges a touched function over the lang threshold", async () => {
  const env = envWith({ functions: [func({ name: "f", cyclomaticComplexity: 9, bodyChanged: true, startLine: 4 })], comments: [] });
  const rules = buildRules(DEFAULT_POLICY, "python");

  const resp = await analyze({ path: "app/foo.py", after: "def f():\n  pass" }, env, rules);

  assert.equal(resp.nudges.length, 1);
  const n = resp.nudges[0];
  if (n === undefined) { assert.fail("expected a nudge"); return; }
  assert.equal(n.rule, RULE.cc);
  assert.equal(n.severity, "nudge");
  assert.equal(n.line, 4);
  assert.match(n.msg, /f \(CC=9\)/);
  assert.match(n.msg, /Threshold is 8/);
});

test("the cc rule stays silent when the touched function is under threshold", async () => {
  const env = envWith({ functions: [func({ cyclomaticComplexity: 8, bodyChanged: true })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the cc rule ignores an over-threshold function that was not touched", async () => {
  const env = envWith({ functions: [func({ cyclomaticComplexity: 9, bodyChanged: false })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the cc rule uses the per-lang threshold", async () => {
  const env = envWith({ functions: [func({ cyclomaticComplexity: 9, bodyChanged: true })], comments: [] });

  const py = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));
  const ts = await analyze({ path: "app/foo.ts", after: "x" }, env, buildRules(DEFAULT_POLICY, "typescript"));
  const cpp = await analyze({ path: "app/foo.cpp", after: "x" }, env, buildRules(DEFAULT_POLICY, "cpp"));

  assert.equal(py.nudges.length, 1);
  assert.equal(ts.nudges.length, 0, "ts threshold 10 lets CC=9 pass");
  assert.equal(cpp.nudges.length, 0, "cpp threshold 12 lets CC=9 pass");
});