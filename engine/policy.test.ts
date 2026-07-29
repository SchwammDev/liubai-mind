import { test } from "node:test";
import assert from "node:assert/strict";

import { analyze } from "./analyze.ts";
import type { CommentFacts, Env, Extracted, FunctionFacts, Lang, RuleConfig } from "./contract.ts";
import { buildRules, DEFAULT_POLICY, RULE } from "./policy.ts";

function envWith(extracted: Extracted, helpers?: () => string[]): Env {
  const env: Env = {
    extractors: {
      python: { extract: () => extracted },
      typescript: { extract: () => extracted },
      cpp: { extract: () => extracted },
    },
  };
  if (helpers !== undefined) env.helpers = helpers;
  return env;
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

test("the test-body rule nudges a touched test function over the lang threshold", async () => {
  const env = envWith({ functions: [func({ name: "f", isTest: true, bodyChanged: true, bodyLineCount: 9, startLine: 4 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
  const n = resp.nudges[0];
  if (n === undefined) { assert.fail("expected a nudge"); return; }
  assert.equal(n.rule, RULE.testBody);
  assert.equal(n.severity, "nudge");
  assert.equal(n.line, 4);
  assert.match(n.msg, /f \(9L\)/);
  assert.match(n.msg, /Threshold is 8/);
});

test("the test-body rule stays silent at the threshold", async () => {
  const env = envWith({ functions: [func({ isTest: true, bodyChanged: true, bodyLineCount: 8 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the test-body rule ignores an over-threshold test that was not touched", async () => {
  const env = envWith({ functions: [func({ isTest: true, bodyChanged: false, bodyLineCount: 9 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the test-body rule ignores a non-test function", async () => {
  const env = envWith({ functions: [func({ isTest: false, bodyChanged: true, bodyLineCount: 9 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the test-body rule uses the per-lang threshold", async () => {
  const policy = {
    ...DEFAULT_POLICY,
    [RULE.testBody]: { ...(DEFAULT_POLICY[RULE.testBody] as RuleConfig), threshold: { typescript: 5 } },
  };
  const env = envWith({ functions: [func({ name: "f", isTest: true, bodyChanged: true, bodyLineCount: 9, startLine: 4 })], comments: [] });

  const resp = await analyze({ path: "app/foo.ts", after: "x" }, env, buildRules(policy, "typescript"));

  assert.equal(resp.nudges.length, 1);
});

test("the test-body rule appends helper hint only on the first nudge", async () => {
  const env = envWith(
    {
      functions: [
        func({ name: "test_a", isTest: true, bodyChanged: true, bodyLineCount: 9, startLine: 4 }),
        func({ name: "test_b", isTest: true, bodyChanged: true, bodyLineCount: 10, startLine: 20 }),
      ],
      comments: [],
    },
    () => ["assert_eq", "assert_throws"],
  );

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 2);
  const first = resp.nudges[0];
  const second = resp.nudges[1];
  if (first === undefined || second === undefined) { assert.fail("expected two nudges"); return; }
  assert.match(first.msg, /Existing helpers: assert_eq, assert_throws\./);
  assert.doesNotMatch(second.msg, /Existing helpers/);
  assert.doesNotMatch(second.msg, /No assert_\*\/_\* helpers/);
});

test("the test-body rule suggests writing a helper when none exist", async () => {
  const env = envWith(
    { functions: [func({ name: "f", isTest: true, bodyChanged: true, bodyLineCount: 9, startLine: 4 })], comments: [] },
    () => [],
  );

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
  const n = resp.nudges[0];
  if (n === undefined) { assert.fail("expected a nudge"); return; }
  assert.match(n.msg, /No assert_\*\/_\* helpers in tests\/ yet — write one\./);
});
function functionsOnly(fns: FunctionFacts[]): Extracted {
  return { functions: fns, comments: [] };
}

function comment(over: Partial<CommentFacts>): CommentFacts {
  return {
    line: over.line ?? 1,
    text: over.text ?? "# noise",
    kind: over.kind ?? "line",
    added: over.added ?? true,
  };
}

function commentsOnly(comments: CommentFacts[]): Extracted {
  return { functions: [], comments };
}

test("discourage-comments nudges an added line comment in python", async () => {
  const cmnt = comment({ line: 7, text: "# fixme", kind: "line", added: true });
  const env = envWith(commentsOnly([cmnt]));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
  const n = resp.nudges[0];
  if (n === undefined) { assert.fail("expected a nudge"); return; }
  assert.equal(n.rule, RULE.discourageComments);
  assert.equal(n.severity, "block");
  assert.equal(n.line, 7);
  assert.match(n.msg, /comments are noise/);
});

test("discourage-comments nudges an added doc comment in python (docs not exempt)", async () => {
  const env = envWith(commentsOnly([comment({ kind: "doc", text: '"""hi"""' })]));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
});

test("discourage-comments nudges an added block comment in python", async () => {
  const env = envWith(commentsOnly([comment({ kind: "block" })]));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
});

test("discourage-comments stays silent for tooling comments", async () => {
  const env = envWith(commentsOnly([comment({ kind: "tooling" })]));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("discourage-comments stays silent for comments that were not added", async () => {
  const env = envWith(commentsOnly([comment({ added: false })]));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("discourage-comments exempts doc comments in cpp headers (*.h)", async () => {
  const env = envWith(commentsOnly([comment({ kind: "doc" })]));

  const resp = await analyze({ path: "inc/foo.h", after: "x" }, env, buildRules(DEFAULT_POLICY, "cpp"));

  assert.deepEqual(resp.nudges, []);
});

test("discourage-comments exempts doc comments in cpp headers (*.hpp)", async () => {
  const env = envWith(commentsOnly([comment({ kind: "doc" })]));

  const resp = await analyze({ path: "inc/foo.hpp", after: "x" }, env, buildRules(DEFAULT_POLICY, "cpp"));

  assert.deepEqual(resp.nudges, []);
});

test("discourage-comments nudges line comments in cpp headers (exemption kinds=[doc] only)", async () => {
  const cmnt = comment({ kind: "line", line: 3 });
  const env = envWith(commentsOnly([cmnt]));

  const resp = await analyze({ path: "inc/foo.h", after: "x" }, env, buildRules(DEFAULT_POLICY, "cpp"));

  assert.equal(resp.nudges.length, 1);
  const n = resp.nudges[0];
  if (n === undefined) { assert.fail("expected a nudge"); return; }
  assert.equal(n.line, 3);
});

test("discourage-comments nudges doc comments in cpp bodies (*.h patterns do not match .cpp)", async () => {
  const env = envWith(commentsOnly([comment({ kind: "doc" })]));

  const resp = await analyze({ path: "src/foo.cpp", after: "x" }, env, buildRules(DEFAULT_POLICY, "cpp"));

  assert.equal(resp.nudges.length, 1);
});

test("discourage-comments nudges doc comments in typescript (exemption langs=[cpp] only)", async () => {
  const env = envWith(commentsOnly([comment({ kind: "doc" })]));

  const resp = await analyze({ path: "app/foo.ts", after: "x" }, env, buildRules(DEFAULT_POLICY, "typescript"));

  assert.equal(resp.nudges.length, 1);
});

test("discourage-comments truncates long comment snippets to 80 chars plus ellipsis", async () => {
  const longText = "# " + "x".repeat(98);
  const env = envWith(commentsOnly([comment({ text: longText })]));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
  const n = resp.nudges[0];
  if (n === undefined) { assert.fail("expected a nudge"); return; }
  assert.ok(n.msg.includes("\u2026"), "msg must contain ellipsis");
  const openQuote = n.msg.indexOf('"');
  const ellipsis = n.msg.indexOf("\u2026");
  const snippet = n.msg.slice(openQuote + 1, ellipsis);
  assert.equal(snippet.length, 80, "snippet before ellipsis must be exactly 80 chars");
  assert.equal(snippet, longText.trimStart().slice(0, 80));
});

test("type-annotation fires when signatureChanged and missing annotations exist", async () => {
  const env = envWith(functionsOnly([func({ name: "f", startLine: 5, signatureChanged: true, missingAnnotations: ["x", "-> return"] })])), rules = buildRules(DEFAULT_POLICY, "python");

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, rules);

  assert.equal(resp.nudges.length, 1);
  const n = resp.nudges[0];
  if (n === undefined) { assert.fail("expected a nudge"); return; }
  assert.equal(n.rule, RULE.typeAnnotation);
  assert.equal(n.severity, "nudge");
  assert.equal(n.line, 5);
  assert.match(n.msg, /f: missing x, -> return\./);
  assert.match(n.msg, /Add hints for every parameter and the return type\./);
});

test("type-annotation stays silent when no missing annotations", async () => {
  const env = envWith(functionsOnly([func({ signatureChanged: true, missingAnnotations: [] })])), rules = buildRules(DEFAULT_POLICY, "python");

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, rules);

  assert.deepEqual(resp.nudges, []);
});

test("type-annotation stays silent when body-only edit (signatureChanged=false)", async () => {
  const env = envWith(functionsOnly([func({ signatureChanged: false, missingAnnotations: ["x"] })])), rules = buildRules(DEFAULT_POLICY, "python");

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, rules);

  assert.deepEqual(resp.nudges, []);
});

test("type-annotation emits one nudge per function", async () => {
  const env = envWith(functionsOnly([
    func({ name: "foo", startLine: 3, signatureChanged: true, missingAnnotations: ["a"] }),
    func({ name: "bar", startLine: 9, signatureChanged: true, missingAnnotations: ["b"] }),
  ])), rules = buildRules(DEFAULT_POLICY, "python");

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, rules);

  assert.equal(resp.nudges.length, 2);
  const [n1, n2] = resp.nudges;
  if (n1 === undefined || n2 === undefined) { assert.fail("expected two nudges"); return; }
  assert.equal(n1.line, 3);
  assert.match(n1.msg, /foo: missing a\./);
  assert.equal(n2.line, 9);
  assert.match(n2.msg, /bar: missing b\./);
});

test("type-annotation stays silent for typescript", async () => {
  const env = envWith(functionsOnly([func({ signatureChanged: true, missingAnnotations: ["x"] })])), rules = buildRules(DEFAULT_POLICY, "typescript");

  const resp = await analyze({ path: "app/foo.ts", after: "x" }, env, rules);

  assert.deepEqual(resp.nudges, []);
});

test("type-annotation stays silent for cpp", async () => {
  const env = envWith(functionsOnly([func({ signatureChanged: true, missingAnnotations: ["x"] })])), rules = buildRules(DEFAULT_POLICY, "cpp");

  const resp = await analyze({ path: "app/foo.cpp", after: "x" }, env, rules);

  assert.deepEqual(resp.nudges, []);
});
