import { test } from "node:test";
import assert from "node:assert/strict";

import { typescriptExtractor, validateFunction, validateComment } from "./extract-typescript.ts";
import type { Extracted, FunctionFacts } from "./contract.ts";

async function extractText(path: string, after: string, before?: string): Promise<Extracted> {
  const res = typescriptExtractor.extract({ path, after, ...(before !== undefined ? { before } : {}) });
  return await Promise.resolve(res);
}

function findFn(ext: Extracted, name: string): FunctionFacts {
  const fn = ext.functions.find((f) => f.name === name);
  if (fn === undefined) assert.fail(`expected function ${name}`);
  return fn;
}

test("function_declaration_is_extracted_with_declared_name", async () => {
  const src = "function foo() {\n  return 1;\n}\n";
  const ext = await extractText("app/foo.ts", src);
  const fn = findFn(ext, "foo");
  assert.equal(fn.startLine, 1);
  assert.equal(fn.isTest, false);
});

test("arrow_function_in_test_callback_uses_description_string", async () => {
  const src = "test('does the thing', () => {\n  return 1;\n});\n";
  const ext = await extractText("app/foo.test.ts", src);
  const fn = findFn(ext, "does the thing");
  assert.equal(fn.isTest, true);
});

test("function_expression_in_test_callback_uses_description_string", async () => {
  const src = "test('does the thing', function () {\n  return 1;\n});\n";
  const ext = await extractText("app/foo.test.ts", src);
  const fn = findFn(ext, "does the thing");
  assert.equal(fn.isTest, true);
});

test("non_test_arrow_function_is_named_anonymous", async () => {
  const src = "const f = () => 1;\n";
  const ext = await extractText("app/foo.ts", src);
  const fn = ext.functions.find((f) => f.name === "anonymous");
  assert.ok(fn !== undefined, "expected an anonymous function");
  assert.equal(fn.isTest, false);
});

test("non_test_function_expression_is_named_anonymous", async () => {
  const src = "const f = function () { return 1; };\n";
  const ext = await extractText("app/foo.ts", src);
  const fn = ext.functions.find((f) => f.name === "anonymous");
  assert.ok(fn !== undefined, "expected an anonymous function");
  assert.equal(fn.isTest, false);
});

test("method_definition_is_extracted_with_method_name", async () => {
  const src = "class C {\n  method() {\n    return 1;\n  }\n}\n";
  const ext = await extractText("app/foo.ts", src);
  const fn = findFn(ext, "method");
  assert.equal(fn.startLine, 2);
  assert.equal(fn.isTest, false);
});

test("test_callback_in_test_ts_is_marked_as_test", async () => {
  const src = "test('a', () => {});\n";
  const ext = await extractText("app/foo.test.ts", src);
  const fn = findFn(ext, "a");
  assert.equal(fn.isTest, true);
});

test("it_callback_in_test_ts_is_marked_as_test", async () => {
  const src = "it('a', () => {});\n";
  const ext = await extractText("app/foo.test.ts", src);
  const fn = findFn(ext, "a");
  assert.equal(fn.isTest, true);
});

test("test_callback_in_spec_ts_is_marked_as_test", async () => {
  const src = "test('a', () => {});\n";
  const ext = await extractText("app/foo.spec.ts", src);
  const fn = findFn(ext, "a");
  assert.equal(fn.isTest, true);
});

test("test_callback_in_tests_underscore_directory_is_marked_as_test", async () => {
  const src = "test('a', () => {});\n";
  const ext = await extractText("__tests__/foo.ts", src);
  const fn = findFn(ext, "a");
  assert.equal(fn.isTest, true);
});

test("test_callback_in_mts_file_is_marked_as_test", async () => {
  const src = "test('a', () => {});\n";
  const ext = await extractText("app/foo.test.mts", src);
  const fn = findFn(ext, "a");
  assert.equal(fn.isTest, true);
});

test("test_callback_in_cts_file_is_marked_as_test", async () => {
  const src = "test('a', () => {});\n";
  const ext = await extractText("app/foo.test.cts", src);
  const fn = findFn(ext, "a");
  assert.equal(fn.isTest, true);
});

test("test_callback_in_plain_ts_path_is_not_marked_as_test", async () => {
  const src = "test('a', () => {});\n";
  const ext = await extractText("app/foo.ts", src);
  const fn = ext.functions[0];
  assert.ok(fn !== undefined);
  assert.equal(fn.name, "anonymous");
  assert.equal(fn.isTest, false);
});

test("non_last_arg_of_test_is_not_marked_as_test", async () => {
  const src = "test(() => {}, 'a');\n";
  const ext = await extractText("app/foo.test.ts", src);
  const fn = ext.functions[0];
  assert.ok(fn !== undefined);
  assert.equal(fn.isTest, false);
});

test("non_test_function_in_test_path_is_not_marked_as_test", async () => {
  const src = "function helper() { return 1; }\n";
  const ext = await extractText("app/foo.test.ts", src);
  const fn = findFn(ext, "helper");
  assert.equal(fn.isTest, false);
});

test("bodyLineCount_counts_statement_lines_not_brace_span", async () => {
  const src = "function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n";
  const ext = await extractText("app/foo.ts", src);
  const fn = findFn(ext, "f");
  assert.equal(fn.bodyLineCount, 3, "expected 3 statement lines, not 5 (brace span)");
});

test("body_only_edit_marks_signature_same_body_changed", async () => {
  const before = "function f(x) {\n  return 1;\n}\n";
  const after = "function f(x) {\n  return 2;\n}\n";
  const ext = await extractText("app/foo.ts", after, before);
  const fn = findFn(ext, "f");
  assert.equal(fn.signature, "same");
  assert.equal(fn.body, "changed");
});

test("signature_edit_marks_signature_changed_body_same", async () => {
  const before = "function f(x) {\n  return 1;\n}\n";
  const after = "function f(x, y) {\n  return 1;\n}\n";
  const ext = await extractText("app/foo.ts", after, before);
  const fn = findFn(ext, "f");
  assert.equal(fn.signature, "changed");
  assert.equal(fn.body, "same");
});

test("new_function_when_no_before_marks_both_new", async () => {
  const after = "function f(x) {\n  return 1;\n}\n";
  const ext = await extractText("app/foo.ts", after);
  const fn = findFn(ext, "f");
  assert.equal(fn.signature, "new");
  assert.equal(fn.body, "new");
});

test("comment_kinds_classify_line_block_doc_tooling", async () => {
  const src = "// line\n/* block */\n/** doc */\n// @ts-ignore\n";
  const ext = await extractText("app/foo.ts", src);
  const byLine = new Map(ext.comments.map((c) => [c.line, c.kind]));
  assert.equal(byLine.get(1), "line");
  assert.equal(byLine.get(2), "block");
  assert.equal(byLine.get(3), "doc");
  assert.equal(byLine.get(4), "tooling");
});

test("pre_existing_comment_not_marked_added", async () => {
  const before = "// old\n";
  const after = "// old\n// new\n";
  const ext = await extractText("app/foo.ts", after, before);
  const byText = new Map(ext.comments.map((c) => [c.text, c.added]));
  assert.equal(byText.get("// old"), false);
  assert.equal(byText.get("// new"), true);
});

test("cyclomaticComplexity_scores_branching_higher_than_flat", async () => {
  const branching = "function f(x) {\n  if (x === 1) { return 1; }\n  else if (x === 2) { return 2; }\n  else if (x === 3) { return 3; }\n  return 0;\n}\n";
  const flat = "function g(x) {\n  return x + 1;\n}\n";
  const ext = await extractText("app/foo.ts", branching + flat);

  assert.ok(findFn(ext, "f").cyclomaticComplexity > 1);
  assert.equal(findFn(ext, "g").cyclomaticComplexity, 1);
});

test("tsx_file_is_parsed_with_tsx_grammar", async () => {
  const src = "function C() {\n  return <div>hi</div>;\n}\n";
  const ext = await extractText("app/foo.tsx", src);
  const fn = findFn(ext, "C");
  assert.equal(fn.name, "C");
});

test("parse_error_returns_empty_facts", async () => {
  const src = "\"unterminated string\n";
  const ext = await extractText("app/foo.ts", src);
  assert.deepEqual(ext, { functions: [], comments: [] });
});

test("a non-test call's trailing callback in a test file stays anonymous and non-test", async () => {
  const src = "outer('desc', () => {\n  return 1;\n});\n";
  const ext = await extractText("app/foo.test.ts", src);
  const fn = ext.functions[0];
  assert.ok(fn !== undefined);
  assert.equal(fn.name, "anonymous");
  assert.equal(fn.isTest, false);
});

const WELL_FORMED_FUNCTION = {
  name: "f", startLine: 1, cyclomaticComplexity: 1, missingAnnotations: [],
  isTest: false, bodyLineCount: 1, signature: "new", body: "new",
};
const WELL_FORMED_COMMENT = { line: 1, text: "// x", kind: "line", added: true };
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
