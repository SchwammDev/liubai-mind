import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { analyze } from "./analyze.ts";
import type { Extracted, FunctionFacts } from "./contract.ts";
import { RULE } from "./contract.ts";
import { buildRules, DEFAULT_POLICY } from "./policy.ts";
import { pythonExtractor } from "./extract-python.ts";

async function extractText(path: string, after: string, before?: string): Promise<Extracted> {
  const res = pythonExtractor.extract({ path, after, ...(before !== undefined ? { before } : {}) });
  return await Promise.resolve(res);
}

function findFn(ext: Extracted, name: string): FunctionFacts {
  const fn = ext.functions.find((f) => f.name === name);
  if (fn === undefined) assert.fail(`expected function ${name}`);
  return fn;
}

test("cyclomatic_complexity_scores_branching_higher_than_flat", async () => {
  const src = "def f(x):\n    if x:\n        return 1\n    elif x:\n        return 2\n    elif x:\n        return 3\ndef g(x):\n    return 1\n";
  const ext = await extractText("app/foo.py", src);

  assert.ok(findFn(ext, "f").cyclomaticComplexity > 1);
  assert.equal(findFn(ext, "g").cyclomaticComplexity, 1);
});

test("body_only_edit_marks_signature_same_body_changed", async () => {
  const before = "def f(x):\n    return 1";
  const after = "def f(x):\n    return 2";
  const ext = await extractText("app/foo.py", after, before);
  const fn = findFn(ext, "f");

  assert.equal(fn.signature, "same");
  assert.equal(fn.body, "changed");
});

test("signature_edit_keeps_body_same", async () => {
  const before = "def f(x):\n    return 1";
  const after = "def f(x, y):\n    return 1";
  const ext = await extractText("app/foo.py", after, before);
  const fn = findFn(ext, "f");

  assert.equal(fn.signature, "changed");
  assert.equal(fn.body, "same");
});

test("new_function_when_no_before_marks_both_new", async () => {
  const after = "def f(x):\n    return 1";
  const ext = await extractText("app/foo.py", after);
  const fn = findFn(ext, "f");

  assert.equal(fn.signature, "new");
  assert.equal(fn.body, "new");
});

test("missing_annotations_skip_self_and_report_return", async () => {
  const src = "def f(self, x):\n    return 1\n";
  const ext = await extractText("app/foo.py", src);
  const fn = findFn(ext, "f");

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
  const src = "# plain\n# type: ignore\n\"\"\"doc\"\"\"\n";
  const ext = await extractText("app/foo.py", src);
  const kinds = new Map(ext.comments.map((c) => [c.line, c.kind]));

  assert.equal(kinds.get(1), "line");
  assert.equal(kinds.get(2), "tooling");
  assert.equal(kinds.get(3), "doc");
});

test("pre_existing_comment_not_marked_added", async () => {
  const before = "# old";
  const after = "# old\n# new";
  const ext = await extractText("app/foo.py", after, before);
  const byLine = new Map(ext.comments.map((c) => [c.text, c.added]));

  assert.equal(byLine.get("# old"), false);
  assert.equal(byLine.get("# new"), true);
});

test("analyze_fires_cc_nudge_from_real_python_source", async () => {
  const src =
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

  const resp = await analyze(
    { path: "app/foo.py", after: src },
    { extractors: { python: pythonExtractor } },
    buildRules(DEFAULT_POLICY, "python"),
  );

  assert.ok(resp.nudges.some((n) => n.rule === RULE.cc));
});

test("lizard_cc_value_matches_hand_crafted_sample", async () => {
  const src =
    "def f(x):\n" +
    "    if x and y:\n" +
    "        return 1\n" +
    "    elif x or w:\n" +
    "        try:\n" +
    "            return 2\n" +
    "        except ValueError:\n" +
    "            return 3\n" +
    "    return 0\n";
  const ext = await extractText("app/foo.py", src);

  assert.equal(findFn(ext, "f").cyclomaticComplexity, 6);
});

test("lizard_cc_overrides_ast_value_for_typical_function", async () => {
  const src =
    "def f(x):\n" +
    "    if x:\n" +
    "        return 1\n" +
    "    elif x:\n" +
    "        return 2\n";
  const ext = await extractText("app/foo.py", src);

  assert.equal(findFn(ext, "f").cyclomaticComplexity, 3);
});

test("lizard_cc_handles_nested_function_namespace_strip", async () => {
  const src =
    "def outer(a):\n" +
    "    def inner(b):\n" +
    "        if b > 0:\n" +
    "            return 1\n" +
    "        return 0\n" +
    "    return inner(a)\n";
  const ext = await extractText("app/foo.py", src);

  const fn = findFn(ext, "inner");
  assert.equal(fn.cyclomaticComplexity, 2);
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
