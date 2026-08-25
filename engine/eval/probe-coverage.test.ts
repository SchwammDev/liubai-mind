import { test } from "node:test";
import assert from "node:assert/strict";

import { entrySpan, runProbesWithCoverage } from "./probe-coverage.ts";
import type { AdequacyResult } from "./probe-coverage.ts";
import type { Probe } from "./eval-contract.ts";
import type { ProbeRunInput } from "./probes.ts";
import { venvPythonAvailable } from "./judge-env.ts";

const TWO_FUNCTIONS_SOURCE = [
  "export function helper(): number {",
  "  return 1;",
  "}",
  "",
  "export function target(x: number): number {",
  "  if (x > 0) {",
  "    return x;",
  "  }",
  "  return 0;",
  "}",
  "",
].join("\n");

const TS_IF_ELSE_SOURCE = [
  "export function classify(x: number): string {",
  "  if (x > 0) {",
  "    return \"positive\";",
  "  } else {",
  "    return \"non-positive\";",
  "  }",
  "}",
  "",
].join("\n");

const TS_IF_ELSE_WITH_UNUSED_HELPER_SOURCE = [
  "export function classify(x: number): string {",
  "  if (x > 0) {",
  "    return \"positive\";",
  "  } else {",
  "    return \"non-positive\";",
  "  }",
  "}",
  "",
  "export function unusedHelper(): number {",
  "  return 999;",
  "}",
  "",
].join("\n");

const PY_IF_ELSE_SOURCE = [
  "def classify(x):",
  "    if x > 0:",
  "        return \"positive\"",
  "    else:",
  "        return \"non-positive\"",
  "",
].join("\n");

const POSITIVE_ONLY_PROBES: Probe[] = [{ args: [1], returns: "positive" }];
const BOTH_BRANCHES_PROBES: Probe[] = [
  { args: [1], returns: "positive" },
  { args: [-1], returns: "non-positive" },
];

function coverageInput(lang: ProbeRunInput["lang"], entryFilename: string, source: string, probes: Probe[]): ProbeRunInput {
  return { lang, entryFilename, source, entrySymbol: "classify", probes };
}

function assertFullyCovered(result: AdequacyResult): void {
  assert.equal(result.outcome.passed, true);
  assert.deepEqual(result.missingInSpan, []);
}

function assertLineIsMissing(result: AdequacyResult, line: number): void {
  assert.ok(result.missingInSpan.includes(line), `expected line ${line} missing, got ${JSON.stringify(result.missingInSpan)}`);
}

function assertOnlyLineMissing(result: AdequacyResult, line: number): void {
  assert.equal(result.outcome.passed, true);
  assert.deepEqual(result.missingInSpan, [line]);
}

function assertNoMissingLinesAtOrAfter(result: AdequacyResult, line: number): void {
  assert.ok(!result.missingInSpan.some((l) => l >= line), `unexpected missing lines at/after ${line}: ${JSON.stringify(result.missingInSpan)}`);
}

test("entrySpan_locates_the_entry_symbol_line_range", async () => {
  const span = await entrySpan("typescript", "two.ts", TWO_FUNCTIONS_SOURCE, "target");

  assert.deepEqual(span, { startLine: 5, endLine: 10 });
});

test("entrySpan_throws_when_the_symbol_is_absent", async () => {
  const source = "export function other(): void {}\n";

  await assert.rejects(() => entrySpan("typescript", "thing.ts", source, "missingFn"), /missingFn/);
});

test("runProbesWithCoverage_reports_no_missing_lines_when_probes_hit_both_branches", async () => {
  const input = coverageInput("typescript", "classify.ts", TS_IF_ELSE_SOURCE, BOTH_BRANCHES_PROBES);

  const result = await runProbesWithCoverage(input);

  assertFullyCovered(result);
});

test("runProbesWithCoverage_reports_the_untaken_branch_line_as_missing", async () => {
  const input = coverageInput("typescript", "classify.ts", TS_IF_ELSE_SOURCE, POSITIVE_ONLY_PROBES);

  const result = await runProbesWithCoverage(input);

  assertLineIsMissing(result, 5);
});

test("runProbesWithCoverage_restricts_missing_lines_to_the_entry_symbol_span", async () => {
  const input = coverageInput("typescript", "classify.ts", TS_IF_ELSE_WITH_UNUSED_HELPER_SOURCE, POSITIVE_ONLY_PROBES);

  const result = await runProbesWithCoverage(input);

  assertLineIsMissing(result, 5);
  assertNoMissingLinesAtOrAfter(result, 9);
});

test("runProbesWithCoverage_python_reports_no_missing_lines_when_probes_hit_both_branches", { skip: !venvPythonAvailable() }, async () => {
  const input = coverageInput("python", "classify.py", PY_IF_ELSE_SOURCE, BOTH_BRANCHES_PROBES);

  const result = await runProbesWithCoverage(input);

  assertFullyCovered(result);
});

test("runProbesWithCoverage_python_reports_the_untaken_branch_line_as_missing", { skip: !venvPythonAvailable() }, async () => {
  const input = coverageInput("python", "classify.py", PY_IF_ELSE_SOURCE, POSITIVE_ONLY_PROBES);

  const result = await runProbesWithCoverage(input);

  assertOnlyLineMissing(result, 5);
});
