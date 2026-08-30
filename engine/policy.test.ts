import { test } from "node:test";
import assert from "node:assert/strict";

import { analyze } from "./analyze.ts";
import type { BeforeFunctionFacts, CommentFacts, Env, Extracted, FunctionFacts, Lang, Nudge, RuleConfig, RuleName } from "./contract.ts";
import { RULE } from "./contract.ts";
import { buildRules, ccDeltaEnabledLangs, DEFAULT_POLICY } from "./policy.ts";
import type { Policy } from "./policy.ts";

const PATH_BY_LANG: Record<Lang, string> = {
  python: "app/foo.py",
  typescript: "app/foo.ts",
  cpp: "src/foo.cpp",
};

function envWith(extracted: Extracted, helpers?: (lang: Lang) => string[]): Env {
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
    name: "f",
    startLine: 1,
    endLine: 3,
    cyclomaticComplexity: 1,
    missingAnnotations: [],
    isTest: false,
    bodyLineCount: 2,
    signature: "same",
    body: "same",
    controlStatementCount: 0,
    rawAssertCount: 0,
    plumbingLines: 0,
    ...over,
  };
}

async function nudgeFor(lang: Lang, extracted: Extracted): Promise<string> {
  const resp = await analyze(
    { path: PATH_BY_LANG[lang], after: "x" },
    envWith(extracted),
    buildRules(DEFAULT_POLICY, lang),
  );
  const first = resp.nudges[0];
  if (first === undefined) { assert.fail(`expected a nudge for ${lang}`); }
  return first.msg;
}

function firstNudge(resp: { nudges: Nudge[] }): Nudge {
  return nthNudge(resp, 0);
}

function nthNudge(resp: { nudges: Nudge[] }, index: number): Nudge {
  const n = resp.nudges[index];
  if (n === undefined) assert.fail(`expected a nudge at index ${index}`);
  return n;
}

function assertNudgeAt(resp: { nudges: Nudge[] }, index: number, expected: { line: number; msgMatch: RegExp }): void {
  const n = nthNudge(resp, index);
  assert.equal(n.line, expected.line);
  assert.match(n.msg, expected.msgMatch);
}

function assertNudge(
  n: Nudge,
  expected: { rule: RuleName; severity: Nudge["severity"]; line: number; msgMatches: RegExp[] },
): void {
  assert.equal(n.rule, expected.rule);
  assert.equal(n.severity, expected.severity);
  assert.equal(n.line, expected.line);
  for (const pattern of expected.msgMatches) assert.match(n.msg, pattern);
}

function assertCcDeltaNudge(n: Nudge, nameMatch: RegExp, dpMatch: RegExp): void {
  assert.equal(n.rule, RULE.ccDelta);
  assert.equal(n.severity, "nudge");
  assert.equal(n.line, undefined);
  assert.match(n.msg, nameMatch);
  assert.match(n.msg, dpMatch);
}

function assertSingleError(
  resp: { nudges: Nudge[]; errors: { source: string; msg: string }[] },
  source: string,
  msgMatch: RegExp,
): void {
  assert.deepEqual(resp.nudges, []);
  assert.equal(resp.errors.length, 1);
  const err = resp.errors[0];
  if (err === undefined) assert.fail("expected an error");
  assert.equal(err.source, source);
  assert.match(err.msg, msgMatch);
}

function assertSnippetTruncatedTo80(msg: string, fullText: string): void {
  assert.ok(msg.includes("…"), "msg must contain ellipsis");
  const snippet = msg.slice(msg.indexOf('"') + 1, msg.indexOf("…"));
  assert.equal(snippet.length, 80, "snippet before ellipsis must be exactly 80 chars");
  assert.equal(snippet, fullText.trimStart().slice(0, 80));
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
  const env = envWith({ functions: [func({ name: "f", cyclomaticComplexity: 9, body: "changed", startLine: 4 })], comments: [] });
  const rules = buildRules(DEFAULT_POLICY, "python");

  const resp = await analyze({ path: "app/foo.py", after: "def f():\n  pass" }, env, rules);

  assert.equal(resp.nudges.length, 1);
  assertNudge(firstNudge(resp), { rule: RULE.cc, severity: "nudge", line: 4, msgMatches: [/^f is making too many decisions/] });
});

test("the cc rule stays silent when the touched function is under threshold", async () => {
  const env = envWith({ functions: [func({ cyclomaticComplexity: 8, body: "changed" })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the cc rule ignores an over-threshold function that was not touched", async () => {
  const env = envWith({ functions: [func({ cyclomaticComplexity: 9, body: "same" })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the cc rule nudges a complex test function too", async () => {
  const env = envWith({ functions: [func({ name: "test_thing", cyclomaticComplexity: 9, isTest: true, body: "changed" })], comments: [] });

  const resp = await analyze({ path: "tests/test_foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.filter((n) => n.rule === RULE.cc).length, 1);
});

test("the cc rule nudges a newly added complex function", async () => {
  const env = envWith({ functions: [func({ cyclomaticComplexity: 9, signature: "new", body: "new" })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.filter((n) => n.rule === RULE.cc).length, 1);
});

test("a threshold rule enabled for a lang it has no threshold for reports an error", async () => {
  const policy = { ...DEFAULT_POLICY, [RULE.cc]: { enabled: ["python"] as Lang[], severity: "nudge" as const } };
  const env = envWith({ functions: [func({ cyclomaticComplexity: 99, body: "changed" })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(policy, "python"));

  assertSingleError(resp, RULE.cc, /no threshold/);
});

test("the cc nudge names the language's own dispatch idiom", async () => {
  const extracted = { functions: [func({ cyclomaticComplexity: 99, body: "changed" })], comments: [] };

  assert.match(await nudgeFor("python", extracted), /dispatch dict/);
  assert.match(await nudgeFor("typescript", extracted), /lookup object/);
  assert.match(await nudgeFor("cpp", extracted), /dispatch table/);
});

async function assertCcThresholdIsEight(lang: Lang): Promise<void> {
  const req = { path: PATH_BY_LANG[lang], after: "x" };
  const rules = buildRules(DEFAULT_POLICY, lang);
  const at = envWith(functionsOnly([func({ cyclomaticComplexity: 8, body: "changed" })]));
  const over = envWith(functionsOnly([func({ cyclomaticComplexity: 9, body: "changed" })]));
  assert.equal((await analyze(req, at, rules)).nudges.length, 0, `${lang} CC=8 should be silent`);
  assert.equal((await analyze(req, over, rules)).nudges.length, 1, `${lang} CC=9 should nudge`);
}

test("the cc threshold is 8 for all langs", async () => {
  for (const lang of ["python", "typescript", "cpp"] as const) {
    await assertCcThresholdIsEight(lang);
  }
});

function beforeFunc(over: Partial<BeforeFunctionFacts>): BeforeFunctionFacts {
  return {
    name: "f",
    cyclomaticComplexity: 1,
    ...over,
  };
}

function ccFns(ccs: number[]): FunctionFacts[] {
  return ccs.map((cc, i) => func({ name: `f${i}`, cyclomaticComplexity: cc }));
}

function withBefore(afterCcs: number[], beforeFunctions: BeforeFunctionFacts[]): Extracted {
  return { ...functionsOnly(ccFns(afterCcs)), beforeFunctions };
}

const SPLIT_BEFORE: BeforeFunctionFacts[] = [beforeFunc({ name: "handleRequest", cyclomaticComplexity: 12 })];

function ccDeltaResp(extracted: Extracted) {
  return analyze({ path: "app/foo.py", after: "x" }, envWith(extracted), buildRules(DEFAULT_POLICY, "python"));
}

test("the cc-delta rule is enabled by default for python and typescript", () => {
  assert.deepEqual(DEFAULT_POLICY[RULE.ccDelta].enabled, ["python", "typescript"]);
});

test("ccDeltaEnabledLangs enables python and typescript when the flag is undefined", () => {
  assert.deepEqual(ccDeltaEnabledLangs(undefined), ["python", "typescript"]);
});

test("ccDeltaEnabledLangs enables python and typescript when the flag is empty", () => {
  assert.deepEqual(ccDeltaEnabledLangs(""), ["python", "typescript"]);
});

test("ccDeltaEnabledLangs returns no langs when the flag is a non-empty string", () => {
  assert.deepEqual(ccDeltaEnabledLangs("1"), []);
});

test("the cc-delta rule nudges a helper split that hides a violation without lowering decision points", async () => {
  const resp = await ccDeltaResp(withBefore([4, 4, 4, 3], SPLIT_BEFORE));

  assert.equal(resp.nudges.length, 1);
  assertCcDeltaNudge(firstNudge(resp), /handleRequest/, /carries 11 decision points where it carried 11/);
});

const CC_DELTA_OFF_POLICY: Policy = {
  ...DEFAULT_POLICY,
  [RULE.ccDelta]: { ...DEFAULT_POLICY[RULE.ccDelta], enabled: ccDeltaEnabledLangs("1") },
};

test("a helper split draws no cc-delta nudge once the rule is disabled for the language", async () => {
  const resp = await analyze({ path: "app/foo.py", after: "x" }, envWith(withBefore([4, 4, 4, 3], SPLIT_BEFORE)), buildRules(CC_DELTA_OFF_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the cc-delta rule stays silent when the split also lowered decision points", async () => {
  const resp = await ccDeltaResp(withBefore([4, 4, 3], SPLIT_BEFORE));

  assert.deepEqual(resp.nudges, []);
});

test("the cc-delta rule stays silent while an after-function is still over threshold", async () => {
  const resp = await ccDeltaResp(withBefore([9, 4, 1], SPLIT_BEFORE));

  assert.deepEqual(resp.nudges, []);
});

test("the cc-delta rule stays silent when the extractor found no before-side functions", async () => {
  const resp = await ccDeltaResp(functionsOnly(ccFns([9])));

  assert.deepEqual(resp.nudges, []);
});

test("the cc-delta rule stays silent when no before-function exceeded the threshold, even if decision points rose", async () => {
  const before = [beforeFunc({ name: "a", cyclomaticComplexity: 4 }), beforeFunc({ name: "b", cyclomaticComplexity: 4 })];

  const resp = await ccDeltaResp(withBefore([5, 5, 5], before));

  assert.deepEqual(resp.nudges, []);
});

test("the test-linearity rule nudges a touched test with a control statement", async () => {
  const env = envWith({ functions: [func({ name: "f", isTest: true, body: "changed", controlStatementCount: 1, startLine: 4 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
  assertNudge(firstNudge(resp), { rule: RULE.testLinearity, severity: "nudge", line: 4, msgMatches: [/^f branches/] });
});

test("the test-linearity rule stays silent at the threshold (controlStatementCount 0)", async () => {
  const env = envWith({ functions: [func({ isTest: true, body: "changed", controlStatementCount: 0 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the test-linearity rule ignores an over-threshold test that was not touched", async () => {
  const env = envWith({ functions: [func({ isTest: true, body: "same", controlStatementCount: 1 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the test-linearity rule ignores a non-test function", async () => {
  const env = envWith({ functions: [func({ isTest: false, body: "changed", controlStatementCount: 1 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the test-assert-pile rule nudges a touched test over the rawAssertCount threshold", async () => {
  const env = envWith({ functions: [func({ name: "f", isTest: true, body: "changed", rawAssertCount: 3, startLine: 4 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
  assertNudge(firstNudge(resp), { rule: RULE.testAssertPile, severity: "nudge", line: 4, msgMatches: [/^f piles 3 raw asserts/] });
});

test("the test-assert-pile rule stays silent at the threshold (rawAssertCount 2)", async () => {
  const env = envWith({ functions: [func({ isTest: true, body: "changed", rawAssertCount: 2 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the test-data-plumbing rule nudges a touched test over the plumbingLines threshold", async () => {
  const env = envWith({ functions: [func({ name: "f", isTest: true, body: "changed", plumbingLines: 7, startLine: 4 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
  assertNudge(firstNudge(resp), { rule: RULE.testDataPlumbing, severity: "nudge", line: 4, msgMatches: [/^f buries 7 lines of literal data/] });
});

test("the test-data-plumbing rule stays silent at the threshold (plumbingLines 6)", async () => {
  const env = envWith({ functions: [func({ isTest: true, body: "changed", plumbingLines: 6 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.deepEqual(resp.nudges, []);
});

test("the test-data-plumbing rule uses the per-lang threshold", async () => {
  const policy = { ...DEFAULT_POLICY, [RULE.testDataPlumbing]: { ...(DEFAULT_POLICY[RULE.testDataPlumbing] as RuleConfig), threshold: { python: 5, typescript: 12, cpp: 6 } } };
  const env = envWith(functionsOnly([func({ isTest: true, body: "changed", plumbingLines: 9 })]));

  const py = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(policy, "python"));
  const ts = await analyze({ path: "app/foo.ts", after: "x" }, env, buildRules(policy, "typescript"));

  assert.equal(py.nudges.length, 1, "python threshold 5 flags plumbingLines 9");
  assert.equal(ts.nudges.length, 0, "typescript threshold 12 lets plumbingLines 9 pass");
});

const TWO_ASSERT_PILE_TESTS: FunctionFacts[] = [
  func({ name: "test_a", isTest: true, body: "changed", rawAssertCount: 3, startLine: 4 }),
  func({ name: "test_b", isTest: true, body: "changed", rawAssertCount: 4, startLine: 20 }),
];

test("the test-assert-pile rule appends helper hint only on the first nudge", async () => {
  const env = envWith(functionsOnly(TWO_ASSERT_PILE_TESTS), () => ["assert_eq", "assert_throws"]);

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 2);
  assert.match(nthNudge(resp, 0).msg, /Existing helpers: assert_eq, assert_throws\./);
  assert.doesNotMatch(nthNudge(resp, 1).msg, /Existing helpers/);
  assert.doesNotMatch(nthNudge(resp, 1).msg, /No assert_\*\/_\* helpers/);
});

test("subsequent test-assert-pile nudges use the short same-smell form", async () => {
  const env = envWith(functionsOnly(TWO_ASSERT_PILE_TESTS), () => []);

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.match(nthNudge(resp, 1).msg, /^test_b: same smell/);
});

test("the test-assert-pile rule suggests writing a helper when none exist", async () => {
  const env = envWith(functionsOnly([func({ name: "f", isTest: true, body: "changed", rawAssertCount: 3, startLine: 4 })]), () => []);

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
  assert.match(firstNudge(resp).msg, /No assert_\*\/_\* helpers in tests\/ yet — write one\./);
});

test("the missing-helper hint names the language's own helper convention", async () => {
  const extracted = { functions: [func({ isTest: true, body: "changed", rawAssertCount: 99 })], comments: [] };

  assert.match(await nudgeFor("python", extracted), /assert_\*\/_\* helpers in tests\//);
  assert.match(await nudgeFor("typescript", extracted), /assert\*\/expect\* helpers in \*\.test\.ts/);
});

test("the helper lookup is asked for the language under analysis", async () => {
  const asked: Lang[] = [];
  const env = envWith(functionsOnly([func({ isTest: true, body: "changed", rawAssertCount: 3 })]), (lang) => { asked.push(lang); return []; });

  await analyze({ path: "app/foo.ts", after: "x" }, env, buildRules(DEFAULT_POLICY, "typescript"));

  assert.deepEqual(asked, ["typescript"]);
});

const TWO_PLUMBING_TESTS: FunctionFacts[] = [
  func({ name: "test_a", isTest: true, body: "changed", plumbingLines: 7, startLine: 4 }),
  func({ name: "test_b", isTest: true, body: "changed", plumbingLines: 8, startLine: 20 }),
];

test("the test-data-plumbing rule uses the first template for the first flagged test and the rest template for later ones", async () => {
  const env = envWith(functionsOnly(TWO_PLUMBING_TESTS));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 2);
  assert.match(nthNudge(resp, 0).msg, /^test_a buries 7 lines of literal data/);
  assert.match(nthNudge(resp, 1).msg, /^test_b: same smell/);
});

test("a test tripping both test-linearity and test-assert-pile yields one nudge from each", async () => {
  const env = envWith({ functions: [func({ name: "f", isTest: true, body: "changed", controlStatementCount: 1, rawAssertCount: 3, startLine: 4 })], comments: [] });

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 2);
  assert.equal(resp.nudges[0]!.rule, RULE.testLinearity);
  assert.equal(resp.nudges[1]!.rule, RULE.testAssertPile);
});

function functionsOnly(fns: FunctionFacts[]): Extracted {
  return { functions: fns, comments: [] };
}

function comment(over: Partial<CommentFacts>): CommentFacts {
  return {
    line: 1,
    text: "# noise",
    kind: "line",
    added: true,
    ...over,
  };
}

function commentsOnly(comments: CommentFacts[]): Extracted {
  return { functions: [], comments };
}

test("discourage-comments nudges an added line comment in python", async () => {
  const env = envWith(commentsOnly([comment({ line: 7, text: "# fixme", kind: "line", added: true })]));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
  assertNudge(firstNudge(resp), { rule: RULE.discourageComments, severity: "block", line: 7, msgMatches: [/comments are noise/] });
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
  const env = envWith(commentsOnly([comment({ kind: "line", line: 3 })]));

  const resp = await analyze({ path: "inc/foo.h", after: "x" }, env, buildRules(DEFAULT_POLICY, "cpp"));

  assert.equal(resp.nudges.length, 1);
  assert.equal(firstNudge(resp).line, 3);
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

test("the comment nudge names the language's own doc-comment form", async () => {
  const extracted = commentsOnly([comment({})]);

  assert.match(await nudgeFor("python", extracted), /Remove docstrings too, not just '#' lines\./);
  assert.match(await nudgeFor("typescript", extracted), /Remove JSDoc blocks too, not just '\/\/' lines\./);
  assert.match(await nudgeFor("cpp", extracted), /Remove Doxygen blocks too, not just '\/\/' lines\./);
});

test("discourage-comments truncates long comment snippets to 80 chars plus ellipsis", async () => {
  const longText = "# " + "x".repeat(98);
  const env = envWith(commentsOnly([comment({ text: longText })]));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assertSnippetTruncatedTo80(firstNudge(resp).msg, longText);
});

test("type-annotation fires when the signature changed and annotations are missing", async () => {
  const env = envWith(functionsOnly([func({ name: "f", startLine: 5, signature: "changed", missingAnnotations: ["x", "-> return"] })]));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
  assertNudge(firstNudge(resp), { rule: RULE.typeAnnotation, severity: "nudge", line: 5, msgMatches: [/f: missing x, -> return\./, /Add hints for every parameter and the return type\./] });
});

test("type-annotation fires for a newly added unannotated function", async () => {
  const env = envWith(functionsOnly([func({ signature: "new", body: "new", missingAnnotations: ["x"] })]));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 1);
});

test("type-annotation stays silent when no missing annotations", async () => {
  const env = envWith(functionsOnly([func({ signature: "changed", missingAnnotations: [] })])), rules = buildRules(DEFAULT_POLICY, "python");

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, rules);

  assert.deepEqual(resp.nudges, []);
});

test("type-annotation stays silent for a body-only edit", async () => {
  const env = envWith(functionsOnly([func({ signature: "same", missingAnnotations: ["x"] })])), rules = buildRules(DEFAULT_POLICY, "python");

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, rules);

  assert.deepEqual(resp.nudges, []);
});

const TWO_UNANNOTATED: FunctionFacts[] = [
  func({ name: "foo", startLine: 3, signature: "changed", missingAnnotations: ["a"] }),
  func({ name: "bar", startLine: 9, signature: "changed", missingAnnotations: ["b"] }),
];

test("type-annotation emits one nudge per function", async () => {
  const env = envWith(functionsOnly(TWO_UNANNOTATED));

  const resp = await analyze({ path: "app/foo.py", after: "x" }, env, buildRules(DEFAULT_POLICY, "python"));

  assert.equal(resp.nudges.length, 2);
  assertNudgeAt(resp, 0, { line: 3, msgMatch: /foo: missing a\./ });
  assertNudgeAt(resp, 1, { line: 9, msgMatch: /bar: missing b\./ });
});

test("type-annotation stays silent for typescript", async () => {
  const env = envWith(functionsOnly([func({ signature: "changed", missingAnnotations: ["x"] })])), rules = buildRules(DEFAULT_POLICY, "typescript");

  const resp = await analyze({ path: "app/foo.ts", after: "x" }, env, rules);

  assert.deepEqual(resp.nudges, []);
});

test("type-annotation stays silent for cpp", async () => {
  const env = envWith(functionsOnly([func({ signature: "changed", missingAnnotations: ["x"] })])), rules = buildRules(DEFAULT_POLICY, "cpp");

  const resp = await analyze({ path: "app/foo.cpp", after: "x" }, env, rules);

  assert.deepEqual(resp.nudges, []);
});
