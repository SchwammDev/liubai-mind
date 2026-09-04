import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBehaviorChecks } from "./behavior-checks.ts";
import type { BehaviorCheckOutcome, BehaviorCheckRunInput } from "./behavior-checks.ts";
import type { BehaviorCheck } from "./eval-contract.ts";
import { venvPythonAvailable } from "./judge-env.ts";

function tsBehaviorCheckOutcome(entrySymbol: string, source: string, behaviorChecks: BehaviorCheck[], opts: Partial<BehaviorCheckRunInput> = {}): BehaviorCheckOutcome {
  return runBehaviorChecks({ lang: "typescript", entryFilename: `${entrySymbol}.ts`, source, entrySymbol, behaviorChecks, ...opts });
}

function pyBehaviorCheckOutcome(entrySymbol: string, source: string, behaviorChecks: BehaviorCheck[], opts: Partial<BehaviorCheckRunInput> = {}): BehaviorCheckOutcome {
  return runBehaviorChecks({ lang: "python", entryFilename: `${entrySymbol}.py`, source, entrySymbol, behaviorChecks, ...opts });
}

function assertPassed(outcome: BehaviorCheckOutcome): void {
  assert.equal(outcome.passed, true);
  assert.deepEqual(outcome.failures, []);
}

function assertFailedWithReason(outcome: BehaviorCheckOutcome, pattern: RegExp): void {
  assert.equal(outcome.passed, false);
  assert.equal(outcome.failures.length, 1);
  assert.equal(outcome.failures[0]?.index, 0);
  assert.match(outcome.failures[0]?.reason ?? "", pattern);
}

function assertFailedAtIndices(outcome: BehaviorCheckOutcome, indices: number[]): void {
  assert.equal(outcome.passed, false);
  assert.deepEqual(
    outcome.failures.map((f) => f.index),
    indices,
  );
}

function tempTraceFile(): { tracePath: string; cleanup: () => void } {
  const traceDir = mkdtempSync(join(tmpdir(), "behaviorCheck-trace-"));
  return { tracePath: join(traceDir, "trace.json"), cleanup: () => rmSync(traceDir, { recursive: true, force: true }) };
}

function assertTraceRun(entrySymbol: string, source: string, behaviorChecks: BehaviorCheck[]): void {
  const { tracePath, cleanup } = tempTraceFile();
  try {
    const outcome = pyBehaviorCheckOutcome(entrySymbol, source, behaviorChecks, { env: { LIUBAI_BEHAVIOR_CHECK_TRACE_OUT: tracePath } });
    assertPassed(outcome);
    assertTraceCoversExecutedLines(tracePath);
  } finally {
    cleanup();
  }
}

test("runBehaviorChecks_passes_when_a_ts_function_returns_the_expected_value", () => {
  const source = "export function double(n: number): number {\n  return n * 2;\n}\n";

  const outcome = tsBehaviorCheckOutcome("double", source, [{ args: [3], returns: 6 }]);

  assertPassed(outcome);
});

test("runBehaviorChecks_fails_with_a_reason_when_a_return_value_differs", () => {
  const source = "export function double(n: number): number {\n  return n * 3;\n}\n";

  const outcome = tsBehaviorCheckOutcome("double", source, [{ args: [3], returns: 6 }]);

  assertFailedWithReason(outcome, /expected 6, got 9/);
});

test("runBehaviorChecks_matches_a_thrown_message_exactly", () => {
  const source =
    "export function validate(n: number): number {\n  if (n < 0) throw new Error('n must be non-negative');\n  return n;\n}\n";

  const outcome = tsBehaviorCheckOutcome("validate", source, [{ args: [-1], throws: "n must be non-negative" }]);

  assertPassed(outcome);
});

test("runBehaviorChecks_fails_when_an_expected_throw_returns_instead", () => {
  const source = "export function validate(n: number): number {\n  return n;\n}\n";

  const outcome = tsBehaviorCheckOutcome("validate", source, [{ args: [-1], throws: "n must be non-negative" }]);

  assertFailedWithReason(outcome, /got return -1/);
});

test("runBehaviorChecks_reports_a_load_error_when_the_entry_symbol_is_missing", () => {
  const source = "export function other(): void {}\n";

  const outcome = tsBehaviorCheckOutcome("missingFn", source, [{ args: [], returns: null }]);

  assertFailedWithReason(outcome, /missingFn/);
});

test("runBehaviorChecks_fails_closed_when_the_source_calls_process_exit", () => {
  const source = ["export function bail(): void {", "  process.exit(1);", "}", ""].join("\n");

  const outcome = tsBehaviorCheckOutcome("bail", source, [{ args: [], returns: null }]);

  assert.equal(outcome.passed, false);
  assert.equal(outcome.failures.length, 1);
});

test("runBehaviorChecks_ignores_stdout_noise_before_the_sentinel_line", () => {
  const source = "export function noisy(n: number): number {\n  console.log('debug noise');\n  return n * 2;\n}\n";

  const outcome = tsBehaviorCheckOutcome("noisy", source, [{ args: [3], returns: 6 }]);

  assertPassed(outcome);
});

test("runBehaviorChecks_times_out_a_hanging_source_as_failed", () => {
  const source = ["export function hang(): void {", "  while (true) {}", "}", ""].join("\n");

  const outcome = tsBehaviorCheckOutcome("hang", source, [{ args: [], returns: null }], { timeoutMs: 1000 });

  assertFailedWithReason(outcome, /timed out after 1000ms/);
});

test("runBehaviorChecks_subset_mode_accepts_an_extra_top_level_key", () => {
  const source = "export function makeThing(): unknown {\n  return { a: 1, b: 2 };\n}\n";

  const outcome = tsBehaviorCheckOutcome("makeThing", source, [{ args: [], returns: { a: 1 } }], { compare: "subset" });

  assertPassed(outcome);
});

test("runBehaviorChecks_subset_mode_accepts_an_extra_nested_key", () => {
  const source = "export function makeThing(): unknown {\n  return { outer: { a: 1, b: 2 } };\n}\n";

  const outcome = tsBehaviorCheckOutcome("makeThing", source, [{ args: [], returns: { outer: { a: 1 } } }], { compare: "subset" });

  assertPassed(outcome);
});

test("runBehaviorChecks_subset_mode_still_fails_on_a_changed_expected_value", () => {
  const source = "export function makeThing(): unknown {\n  return { a: 2 };\n}\n";

  const outcome = tsBehaviorCheckOutcome("makeThing", source, [{ args: [], returns: { a: 1 } }], { compare: "subset" });

  assertFailedWithReason(outcome, /expected .*"a":1.*, got .*"a":2/);
});

test("runBehaviorChecks_subset_mode_still_fails_on_a_missing_expected_key", () => {
  const source = "export function makeThing(): unknown {\n  return { a: 1 };\n}\n";

  const outcome = tsBehaviorCheckOutcome("makeThing", source, [{ args: [], returns: { a: 1, b: 2 } }], { compare: "subset" });

  assertFailedWithReason(outcome, /expected .*"a":1,"b":2.*, got .*"a":1/);
});

test("runBehaviorChecks_array_length_mismatch_fails_in_subset_mode", () => {
  const source = "export function makeThing(): unknown {\n  return [1, 2];\n}\n";

  const outcome = tsBehaviorCheckOutcome("makeThing", source, [{ args: [], returns: [1, 2, 3] }], { compare: "subset" });

  assertFailedWithReason(outcome, /expected .*\[1,2,3\].*, got .*\[1,2\]/);
});

test("runBehaviorChecks_default_exact_mode_still_rejects_extra_keys", () => {
  const source = "export function makeThing(): unknown {\n  return { a: 1, b: 2 };\n}\n";

  const outcome = tsBehaviorCheckOutcome("makeThing", source, [{ args: [], returns: { a: 1 } }]);

  assertFailedWithReason(outcome, /expected .*"a":1.*, got .*"a":1,"b":2/);
});

test("runBehaviorChecks_python_subset_mode_accepts_an_extra_dict_key", { skip: !venvPythonAvailable() }, () => {
  const source = "def make_thing(_ignored=None):\n    return {'a': 1, 'b': 2}\n";

  const outcome = pyBehaviorCheckOutcome("make_thing", source, [{ args: [], returns: { a: 1 } }], { compare: "subset" });

  assertPassed(outcome);
});

test("runBehaviorChecks_python_passes_on_a_matching_return", { skip: !venvPythonAvailable() }, () => {
  const source = ["def double(n):", "    return n * 2", ""].join("\n");

  const outcome = pyBehaviorCheckOutcome("double", source, [{ args: [3], returns: 6 }]);

  assertPassed(outcome);
});

test("runBehaviorChecks_python_bool_does_not_equal_int_one", { skip: !venvPythonAvailable() }, () => {
  const source = "def flag(n):\n    if n == 0:\n        return 1\n    return True\n";
  const behaviorChecks: BehaviorCheck[] = [{ args: [0], returns: true }, { args: [1], returns: 1 }];

  const outcome = pyBehaviorCheckOutcome("flag", source, behaviorChecks);

  assertFailedAtIndices(outcome, [0, 1]);
});

test("runBehaviorChecks_python_int_expected_matches_float_return", { skip: !venvPythonAvailable() }, () => {
  const source = ["def price(_ignored):", "    return 18.0", ""].join("\n");

  const outcome = pyBehaviorCheckOutcome("price", source, [{ args: [0], returns: 18 }]);

  assertPassed(outcome);
});

test("runBehaviorChecks_python_matches_a_raised_message_exactly", { skip: !venvPythonAvailable() }, () => {
  const source = "def validate(n):\n    if n < 0:\n        raise ValueError('n must be non-negative')\n    return n\n";

  const outcome = pyBehaviorCheckOutcome("validate", source, [{ args: [-1], throws: "n must be non-negative" }]);

  assertPassed(outcome);
});

test("runBehaviorChecks_python_leaves_a_shared_module_dict_unmutated_across_behaviorChecks", { skip: !venvPythonAvailable() }, () => {
  const source = "SHARED = {'a': 1, 'b': 2}\n\ndef get_shared(_ignored):\n    return SHARED\n";
  const behaviorChecks: BehaviorCheck[] = [{ args: [1], returns: { a: 1, b: 2 } }, { args: [2], returns: { a: 1, b: 2 } }];

  const outcome = pyBehaviorCheckOutcome("get_shared", source, behaviorChecks);

  assertPassed(outcome);
});

test("runBehaviorChecks_python_writes_trace_lines_when_the_trace_env_var_is_set", { skip: !venvPythonAvailable() }, () => {
  const source = "def classify(n):\n    if n > 0:\n        return 'positive'\n    return 'non-positive'\n";

  assertTraceRun("classify", source, [{ args: [1], returns: "positive" }]);
});

test("runBehaviorChecks_materializes_sandbox_files_beside_the_entry_for_ts_imports", () => {
  const source = 'import { FACTOR } from "./helpers.ts";\nexport function double(n: number): number {\n  return n * FACTOR;\n}\n';
  const files = { "helpers.ts": "export const FACTOR = 2;\n" };

  const outcome = tsBehaviorCheckOutcome("double", source, [{ args: [3], returns: 6 }], { files });

  assertPassed(outcome);
});

test("runBehaviorChecks_creates_directories_for_nested_sandbox_files", () => {
  const source = 'import { FACTOR } from "./lib/helpers.ts";\nexport function double(n: number): number {\n  return n * FACTOR;\n}\n';
  const files = { "lib/helpers.ts": "export const FACTOR = 2;\n" };

  const outcome = tsBehaviorCheckOutcome("double", source, [{ args: [3], returns: 6 }], { files });

  assertPassed(outcome);
});

test("runBehaviorChecks_lets_the_entry_source_win_a_filename_collision_with_a_sandbox_file", () => {
  const source = "export function double(n: number): number {\n  return n * 2;\n}\n";
  const files = { "double.ts": "export function double(): number {\n  return 0;\n}\n" };

  const outcome = tsBehaviorCheckOutcome("double", source, [{ args: [3], returns: 6 }], { files });

  assertPassed(outcome);
});

test("runBehaviorChecks_throws_on_a_sandbox_path_that_escapes_the_workdir", () => {
  const source = "export function double(n: number): number {\n  return n * 2;\n}\n";
  const behaviorChecks: BehaviorCheck[] = [{ args: [3], returns: 6 }];

  assert.throws(() => tsBehaviorCheckOutcome("double", source, behaviorChecks, { files: { "../evil.ts": "" } }), /unsafe file path/);
  assert.throws(() => tsBehaviorCheckOutcome("double", source, behaviorChecks, { files: { "/tmp/evil.ts": "" } }), /unsafe file path/);
});

test("runBehaviorChecks_ts_fails_as_load_error_when_the_import_specifier_is_extensionless", () => {
  const source = 'import { FACTOR } from "./helpers";\nexport function double(n: number): number {\n  return n * FACTOR;\n}\n';
  const files = { "helpers.ts": "export const FACTOR = 2;\n" };

  const outcome = tsBehaviorCheckOutcome("double", source, [{ args: [3], returns: 6 }], { files });

  assertFailedWithReason(outcome, /helpers/);
});

test("runBehaviorChecks_python_imports_a_sandbox_helper_module", { skip: !venvPythonAvailable() }, () => {
  const source = "import helpers\n\n\ndef double(n):\n    return n * helpers.factor()\n";
  const files = { "helpers.py": "def factor():\n    return 2\n" };

  const outcome = pyBehaviorCheckOutcome("double", source, [{ args: [3], returns: 6 }], { files });

  assertPassed(outcome);
});

function assertTraceCoversExecutedLines(tracePath: string): void {
  const trace: { executed: number[]; executable: number[] } = JSON.parse(readFileSync(tracePath, "utf8"));
  assert.ok(trace.executed.length > 0);
  assert.ok(trace.executable.length > 0);
  assert.ok(trace.executed.every((line) => trace.executable.includes(line)));
}
