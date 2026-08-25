import { test } from "node:test";
import assert from "node:assert/strict";

import { sourceParses, sourceParsesPy } from "./parse-check.ts";
import type { PyRunner } from "./silent-handlers.ts";
import { venvPythonAvailable } from "./judge-env.ts";

test("sourceParses_accepts_valid_typescript", () => {
  const src = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

  const parses = sourceParses(src, "typescript");

  assert.equal(parses, true);
});

test("sourceParses_rejects_typescript_with_a_syntax_error", () => {
  const src = "export function add(a: number, b: number): number {\n  return a +\n}\n";

  const parses = sourceParses(src, "typescript");

  assert.equal(parses, false);
});

test("sourceParses_rejects_typescript_where_only_part_of_the_source_is_broken", () => {
  const src = "export function f(x: number): number { return x; }\n)))garbage(((\n";

  const parses = sourceParses(src, "typescript");

  assert.equal(parses, false);
});

test("sourceParses_accepts_valid_python", { skip: !venvPythonAvailable() }, () => {
  const src = "def add(a, b):\n    return a + b\n";

  const parses = sourceParses(src, "python");

  assert.equal(parses, true);
});

test("sourceParses_rejects_python_with_a_syntax_error", { skip: !venvPythonAvailable() }, () => {
  const src = "def add(a, b):\n    return a +\n";

  const parses = sourceParses(src, "python");

  assert.equal(parses, false);
});

test("sourceParsesPy_reports_the_parsed_flag_from_the_runner_output", () => {
  const fakeRunner: PyRunner = () => JSON.stringify({ parsed: false });

  const parses = sourceParsesPy("irrelevant", fakeRunner);

  assert.equal(parses, false);
});
