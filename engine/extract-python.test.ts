import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { analyze } from "./analyze.ts";
import type { BeforeFunctionFacts, Extracted, FunctionFacts } from "./contract.ts";
import { RULE } from "./contract.ts";
import { buildRules, DEFAULT_POLICY } from "./policy.ts";
import { pythonExtractor, validateFunction, validateComment } from "./extract-python.ts";

const BRANCHING_THEN_FLAT =
  "def f(x):\n    if x:\n        return 1\n    elif x:\n        return 2\n    elif x:\n        return 3\ndef g(x):\n    return 1\n";

const AND_OR_TRY_EXCEPT =
  "def f(x):\n" +
  "    if x and y:\n" +
  "        return 1\n" +
  "    elif x or w:\n" +
  "        try:\n" +
  "            return 2\n" +
  "        except ValueError:\n" +
  "            return 3\n" +
  "    return 0\n";

const TWO_BRANCHES =
  "def f(x):\n" +
  "    if x:\n" +
  "        return 1\n" +
  "    elif x:\n" +
  "        return 2\n";

const NESTED_INNER =
  "def outer(a):\n" +
  "    def inner(b):\n" +
  "        if b > 0:\n" +
  "            return 1\n" +
  "        return 0\n" +
  "    return inner(a)\n";

const EIGHT_ELIF =
  "def big(x):\n" +
  "    if x == 1:\n        return 1\n" +
  "    elif x == 2:\n        return 2\n" +
  "    elif x == 3:\n        return 3\n" +
  "    elif x == 4:\n        return 4\n" +
  "    elif x == 5:\n        return 5\n" +
  "    elif x == 6:\n        return 6\n" +
  "    elif x == 7:\n        return 7\n" +
  "    elif x == 8:\n        return 8\n" +
  "    return 0\n";

async function extractText(path: string, after: string, before?: string): Promise<Extracted> {
  const res = pythonExtractor.extract({ path, after, ...(before !== undefined ? { before } : {}) });
  return await Promise.resolve(res);
}

function findFn(ext: Extracted, name: string): FunctionFacts {
  const fn = ext.functions.find((f) => f.name === name);
  if (fn === undefined) assert.fail(`expected function ${name}`);
  return fn;
}

function findBeforeFn(ext: Extracted, name: string): BeforeFunctionFacts {
  const fn = ext.beforeFunctions?.find((f) => f.name === name);
  if (fn === undefined) assert.fail(`expected before function ${name}`);
  return fn;
}

async function ccOf(src: string, name = "f"): Promise<number> {
  return findFn(await extractText("app/foo.py", src), name).cyclomaticComplexity;
}

async function controlStatementCountOf(src: string, name = "f"): Promise<number> {
  return findFn(await extractText("app/foo.py", src), name).controlStatementCount;
}

async function rawAssertCountOf(src: string, name = "f"): Promise<number> {
  return findFn(await extractText("app/foo.py", src), name).rawAssertCount;
}

async function plumbingLinesOf(src: string, name = "f"): Promise<number> {
  return findFn(await extractText("app/foo.py", src), name).plumbingLines;
}

test("cyclomatic_complexity_scores_branching_higher_than_flat", async () => {
  const ext = await extractText("app/foo.py", BRANCHING_THEN_FLAT);

  assert.ok(findFn(ext, "f").cyclomaticComplexity > 1);
  assert.equal(findFn(ext, "g").cyclomaticComplexity, 1);
});

test("body_only_edit_marks_signature_same_body_changed", async () => {
  const before = "def f(x):\n    return 1";
  const after = "def f(x):\n    return 2";

  const fn = findFn(await extractText("app/foo.py", after, before), "f");

  assert.equal(fn.signature, "same");
  assert.equal(fn.body, "changed");
});

test("signature_edit_keeps_body_same", async () => {
  const before = "def f(x):\n    return 1";
  const after = "def f(x, y):\n    return 1";

  const fn = findFn(await extractText("app/foo.py", after, before), "f");

  assert.equal(fn.signature, "changed");
  assert.equal(fn.body, "same");
});

test("new_function_when_no_before_marks_both_new", async () => {
  const fn = findFn(await extractText("app/foo.py", "def f(x):\n    return 1"), "f");

  assert.equal(fn.signature, "new");
  assert.equal(fn.body, "new");
});

test("beforeFunctions_reports_cyclomatic_complexity_of_a_branching_before_function", async () => {
  const ext = await extractText("app/foo.py", "def f(x):\n    return 1\n", AND_OR_TRY_EXCEPT);

  const fn = findBeforeFn(ext, "f");

  assert.equal(fn.cyclomaticComplexity, 6);
});

test("beforeFunctions_is_undefined_when_extraction_has_no_before", async () => {
  const ext = await extractText("app/foo.py", "def f():\n    return 1\n");

  assert.equal(ext.beforeFunctions, undefined);
});

test("missing_annotations_skip_self_and_report_return", async () => {
  const fn = findFn(await extractText("app/foo.py", "def f(self, x):\n    return 1\n"), "f");

  assert.ok(fn.missingAnnotations.includes("x"));
  assert.ok(fn.missingAnnotations.includes("-> return"));
  assert.ok(!fn.missingAnnotations.includes("self"));
});

test("test_detection_requires_test_prefix_and_test_path", async () => {
  const defn = "def test_thing():\n    pass\n";
  const helper = "def helper():\n    pass\n";

  assert.equal(findFn(await extractText("tests/test_foo.py", defn), "test_thing").isTest, true);
  assert.equal(findFn(await extractText("app/foo.py", defn), "test_thing").isTest, false);
  assert.equal(findFn(await extractText("tests/test_foo.py", helper), "helper").isTest, false);
});

test("comment_kinds_plain_tooling_and_doc", async () => {
  const ext = await extractText("app/foo.py", "# plain\n# type: ignore\n\"\"\"doc\"\"\"\n");
  const kinds = new Map(ext.comments.map((c) => [c.line, c.kind]));

  assert.equal(kinds.get(1), "line");
  assert.equal(kinds.get(2), "tooling");
  assert.equal(kinds.get(3), "doc");
});

test("pre_existing_comment_not_marked_added", async () => {
  const ext = await extractText("app/foo.py", "# old\n# new", "# old");
  const byText = new Map(ext.comments.map((c) => [c.text, c.added]));

  assert.equal(byText.get("# old"), false);
  assert.equal(byText.get("# new"), true);
});

test("analyze_fires_cc_nudge_from_real_python_source", async () => {
  const resp = await analyze(
    { path: "app/foo.py", after: EIGHT_ELIF },
    { extractors: { python: pythonExtractor } },
    buildRules(DEFAULT_POLICY, "python"),
  );

  assert.ok(resp.nudges.some((n) => n.rule === RULE.cc));
});

test("lizard_cc_value_matches_hand_crafted_sample", async () => {
  assert.equal(await ccOf(AND_OR_TRY_EXCEPT), 6);
});

test("lizard_cc_overrides_ast_value_for_typical_function", async () => {
  assert.equal(await ccOf(TWO_BRANCHES), 3);
});

test("lizard_cc_handles_nested_function_namespace_strip", async () => {
  assert.equal(await ccOf(NESTED_INNER, "inner"), 2);
});

test("control_statement_count_counts_if_and_for_and_elif_adds_one_more", async () => {
  const src =
    "def f(x):\n" +
    "    if x:\n" +
    "        return 1\n" +
    "    elif x:\n" +
    "        return 2\n" +
    "    for i in range(x):\n" +
    "        pass\n" +
    "    return 0\n";

  assert.equal(await controlStatementCountOf(src), 3);
});

test("with_block_ternary_and_bool_op_are_not_counted_as_control_statements", async () => {
  const src =
    "def f(x):\n" +
    "    with pytest.raises(ValueError):\n" +
    "        y = 1 if x else 2\n" +
    "        z = x and y\n" +
    "    return y\n";

  assert.equal(await controlStatementCountOf(src), 0);
});

test("nested_inner_function_statements_are_excluded_from_the_outer_functions_facts", async () => {
  const src =
    "def outer(a):\n" +
    "    def inner(b):\n" +
    "        if b > 0:\n" +
    "            assert b and a\n" +
    "            data = {\n" +
    "                'x': 1,\n" +
    "            }\n" +
    "        return 0\n" +
    "    return inner(a)\n";

  const ext = await extractText("app/foo.py", src);
  const outer = findFn(ext, "outer");

  assert.equal(outer.controlStatementCount, 0);
  assert.equal(outer.rawAssertCount, 0);
  assert.equal(outer.plumbingLines, 0);
});

test("three_plain_assert_statements_count_three", async () => {
  const src = "def f():\n    assert a\n    assert b\n    assert c\n";

  assert.equal(await rawAssertCountOf(src), 3);
});

test("and_joined_assert_counts_one_per_operand_but_or_joined_assert_stays_one", async () => {
  const src =
    "def f():\n    assert a and b\n" +
    "def g():\n    assert a and b and c\n" +
    "def h():\n    assert a or b\n";

  assert.equal(await rawAssertCountOf(src, "f"), 2);
  assert.equal(await rawAssertCountOf(src, "g"), 3);
  assert.equal(await rawAssertCountOf(src, "h"), 1);
});

test("helper_call_assertion_is_not_a_raw_assert", async () => {
  const src = "def f():\n    assert_frame_equal(a, b)\n";

  assert.equal(await rawAssertCountOf(src), 0);
});

test("multiline_literal_assignment_adds_its_full_line_span_to_plumbing_lines", async () => {
  const src =
    "def f():\n" +
    "    data = {\n" +
    "        'a': 1,\n" +
    "        'b': 2,\n" +
    "    }\n" +
    "    return data\n";

  assert.equal(await plumbingLinesOf(src), 4);
});

test("assignment_with_a_call_on_the_right_hand_side_adds_no_plumbing_lines", async () => {
  const src = "def f():\n    result = client.score(x)\n    return result\n";

  assert.equal(await plumbingLinesOf(src), 0);
});

test("missing_lizard_hard_fails_with_install_message", async () => {
  const systemPythonWithoutLizard = "/usr/bin/python3";
  const res = spawnSync(systemPythonWithoutLizard, [join(import.meta.dirname, "extract-python.py")], {
    input: JSON.stringify({ path: "x.py", after: "def f(): pass" }),
    encoding: "utf8",
  });

  assert.equal(res.status, 2);
  assert.ok(res.stderr.includes("lizard not installed"));
  assert.ok(res.stderr.includes("uv pip install lizard"));
});

const WELL_FORMED_FUNCTION = {
  name: "f", startLine: 1, endLine: 1, cyclomaticComplexity: 1, missingAnnotations: [],
  isTest: false, bodyLineCount: 1, signature: "new", body: "new",
  controlStatementCount: 0, rawAssertCount: 0, plumbingLines: 0,
};

const WELL_FORMED_COMMENT = { line: 1, text: "# x", kind: "line", added: true };

function rejectsFunctionWith(override: Record<string, unknown>): void {
  assert.throws(() => validateFunction({ ...WELL_FORMED_FUNCTION, ...override }));
}

function rejectsCommentWith(override: Record<string, unknown>): void {
  assert.throws(() => validateComment({ ...WELL_FORMED_COMMENT, ...override }));
}

test("validateFunction rejects a non-object or a mistyped scalar field", () => {
  assert.throws(() => validateFunction(null));
  rejectsFunctionWith({ name: 1 });
  rejectsFunctionWith({ startLine: "1" });
  rejectsFunctionWith({ cyclomaticComplexity: "1" });
  rejectsFunctionWith({ isTest: "no" });
  rejectsFunctionWith({ bodyLineCount: "1" });
  rejectsFunctionWith({ controlStatementCount: "1" });
  rejectsFunctionWith({ rawAssertCount: "1" });
  rejectsFunctionWith({ plumbingLines: "1" });
});

test("validateFunction rejects a malformed annotations list or change field", () => {
  rejectsFunctionWith({ missingAnnotations: "x" });
  rejectsFunctionWith({ missingAnnotations: [1] });
  rejectsFunctionWith({ signature: "maybe" });
  rejectsFunctionWith({ body: "maybe" });
});

test("validateComment rejects a non-object or a mistyped field", () => {
  assert.throws(() => validateComment(null));
  rejectsCommentWith({ line: "1" });
  rejectsCommentWith({ text: 1 });
  rejectsCommentWith({ kind: "weird" });
  rejectsCommentWith({ added: "yes" });
});
