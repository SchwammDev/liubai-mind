import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCases, copyPlan } from "./corpus.ts";
import type { CaseManifest, BaselineMetrics, RawRow, Provenance } from "./eval-contract.ts";
import { decisionPoints } from "./judge.ts";
import { countSilentHandlers } from "./silent-handlers.ts";
import { typescriptExtractor } from "../extract-typescript.ts";
import { pythonExtractor } from "../extract-python.ts";
import type { FunctionFacts, Lang } from "../contract.ts";
import { DEFAULT_POLICY, RULE } from "../policy.ts";
import { runProbesWithCoverage } from "./probe-coverage.ts";
import { runProbes } from "./probes.ts";
import type { ProbeFailure, ProbeOutcome } from "./probes.ts";
import { venvPythonAvailable } from "./judge-env.ts";
import { judgeRows } from "./score.ts";

const CORPUS_DIR = join(import.meta.dirname, "corpus");
const FIXTURES_DIR = join(import.meta.dirname, "fixtures");
const CC_RAIL_THRESHOLD = DEFAULT_POLICY[RULE.cc].threshold!;

function assertLoaded(result: ReturnType<typeof loadCases>): asserts result is CaseManifest[] {
  assert.ok(Array.isArray(result), "expected cases to load");
}

function assertRejected(result: ReturnType<typeof loadCases>): asserts result is { error: string } {
  assert.ok(!Array.isArray(result) && "error" in result, "expected cases to be rejected");
}

function tempCorpusDir(): string {
  return mkdtempSync(join(tmpdir(), "eval-corpus-"));
}

function defaultProbes(): unknown[] {
  return [{ args: [1], returns: 2 }];
}

function writeCase(
  corpusDir: string,
  id: string,
  manifest: object,
  files: Record<string, string>,
  probes: unknown[] | null = defaultProbes(),
): string {
  const caseDir = join(corpusDir, id);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, "manifest.json"), JSON.stringify(manifest));
  if (probes !== null) {
    writeFileSync(join(caseDir, "probes.json"), JSON.stringify(probes));
  }
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(caseDir, name), content);
  }
  return caseDir;
}

function writeReference(caseDir: string, files: Record<string, string>): void {
  const referenceDir = join(caseDir, "reference");
  mkdirSync(referenceDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(referenceDir, name), content);
  }
}

function minimalManifest(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "case-a",
    lang: "typescript",
    files: ["thing.ts.case"],
    entry: "thing.ts",
    entrySymbol: "f",
    task: "Improve thing.ts. Keep the public function signature and behavior unchanged.",
    baseline: { decisionPoints: 1, functions: 1, silentHandlers: 0 },
    tier: "easy",
    ...over,
  };
}

test("loadCases_loads_all_committed_cases", () => {
  const result = loadCases(CORPUS_DIR);

  assertLoaded(result);
  const ids = result.map((c) => c.id).sort();
  assert.deepEqual(ids, [
    "py-config-loader",
    "py-ingest-bait",
    "py-membership-renewal",
    "py-password-strength",
    "py-safe-convert",
    "py-status-dispatch",
    "py-ticket-price",
    "py-timeseries-qc",
    "ts-booking-quote",
    "ts-event-router",
    "ts-flag-parser",
    "ts-grade-bands",
    "ts-order-validator",
    "ts-retry-config",
    "ts-shipping-cost",
    "ts-telemetry-pipeline",
  ]);
});

function minimalCaseManifest(over: Partial<CaseManifest> = {}): CaseManifest {
  return {
    id: "case-a",
    lang: "typescript",
    files: ["parse_flags.ts.case"],
    entry: "parse_flags.ts",
    entrySymbol: "parseFlags",
    task: "Improve parse_flags.ts. Keep the public function signature and behavior unchanged.",
    baseline: { decisionPoints: 1, functions: 1, silentHandlers: 0 },
    tier: "easy",
    probes: [{ args: [[]], returns: {} }],
    ...over,
  };
}

test("copyPlan_strips_the_trailing_case_suffix_from_each_file", () => {
  const kase = minimalCaseManifest();

  const plan = copyPlan("/repo/corpus/case-a", kase, "/work/dir");

  assert.deepEqual(plan, [
    { from: "/repo/corpus/case-a/parse_flags.ts.case", to: "/work/dir/parse_flags.ts" },
  ]);
});

test("copyPlan_never_copies_manifest_or_probes_json", () => {
  const kase = minimalCaseManifest();

  const plan = copyPlan("/repo/corpus/case-a", kase, "/work/dir");

  const copiedBasenames = plan.map((p) => p.from.split("/").pop());
  assert.equal(copiedBasenames.includes("manifest.json"), false);
  assert.equal(copiedBasenames.includes("probes.json"), false);
});

test("copyPlan_never_copies_reference_files_even_when_the_manifest_has_them", () => {
  const kase = minimalCaseManifest({ reference: { parse_flags: "export function parseFlags() {}\n" } });

  const plan = copyPlan("/repo/corpus/case-a", kase, "/work/dir");

  assert.deepEqual(plan, [{ from: "/repo/corpus/case-a/parse_flags.ts.case", to: "/work/dir/parse_flags.ts" }]);
});

test("loadCases_rejects_a_manifest_whose_entry_matches_no_file", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "bad-entry", minimalManifest({ entry: "missing.ts" }), { "thing.ts.case": "export function f() {}\n" });

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /bad-entry/);
});

test("loadCases_rejects_a_manifest_whose_declared_file_is_missing_on_disk", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "missing-source", minimalManifest(), {});

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /missing-source/);
});

function minimalFiles(): Record<string, string> {
  return { "thing.ts.case": "export function f() {}\n" };
}

test("loadCases_rejects_a_manifest_missing_entrySymbol", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "no-entry-symbol", minimalManifest({ entrySymbol: undefined }), minimalFiles());

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /no-entry-symbol/);
});

test("loadCases_rejects_a_manifest_missing_tier", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "no-tier", minimalManifest({ tier: undefined }), minimalFiles());

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /no-tier/);
});

test("loadCases_rejects_a_manifest_with_an_unknown_tier_value", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "bad-tier", minimalManifest({ tier: "medium" }), minimalFiles());

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /bad-tier/);
});

test("loadCases_rejects_a_hard_tier_manifest_without_genuineDpMax", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "hard-no-genuine-dp-max", minimalManifest({ tier: "hard" }), minimalFiles());

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /hard-no-genuine-dp-max/);
});

test("loadCases_rejects_a_genuineDpMax_at_or_above_baseline_decisionPoints", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "genuine-dp-max-too-high", minimalManifest({ tier: "hard", genuineDpMax: 1 }), minimalFiles());

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /genuine-dp-max-too-high/);
});

test("loadCases_rejects_a_non_integer_genuineDpMax", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "genuine-dp-max-not-integer", minimalManifest({ tier: "hard", genuineDpMax: 0.5 }), minimalFiles());

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /genuine-dp-max-not-integer/);
});

test("loadCases_rejects_an_empty_tags_array", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "empty-tags", minimalManifest({ tags: [] }), minimalFiles());

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /empty-tags/);
});

test("loadCases_rejects_an_unknown_top_level_manifest_key", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "unknown-key", minimalManifest({ bogus: "nope" }), minimalFiles());

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /unknown top-level key\(s\): bogus/);
});

test("loadCases_rejects_a_case_without_probes_json", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "no-probes", minimalManifest(), minimalFiles(), null);

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /no-probes/);
});

test("loadCases_rejects_a_probe_with_both_returns_and_throws", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "probe-both", minimalManifest(), minimalFiles(), [{ args: [], returns: 1, throws: "boom" }]);

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /probe-both/);
});

test("loadCases_rejects_a_probe_with_neither_returns_nor_throws", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "probe-neither", minimalManifest(), minimalFiles(), [{ args: [] }]);

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /probe-neither/);
});

test("loadCases_rejects_an_empty_probes_array", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "probe-empty", minimalManifest(), minimalFiles(), []);

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /probe-empty/);
});

test("loadCases_rejects_a_probe_whose_throws_is_not_a_string", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "probe-throws-not-string", minimalManifest(), minimalFiles(), [{ args: [], throws: 42 }]);

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /probe-throws-not-string/);
});

test("loadCases_merges_probes_from_probes_json_into_the_manifest", () => {
  const dir = tempCorpusDir();
  const probes = [{ args: [1, 2], returns: 3 }];
  writeCase(dir, "probe-merge", minimalManifest(), minimalFiles(), probes);

  const result = loadCases(dir);

  assertLoaded(result);
  assert.deepEqual(result[0]?.probes, probes);
});

function tierFields(kase: CaseManifest | undefined) {
  return { tier: kase?.tier, tags: kase?.tags, genuineDpMax: kase?.genuineDpMax };
}

test("loadCases_loads_a_hard_manifest_with_tags_and_genuineDpMax", () => {
  const dir = tempCorpusDir();
  const caseDir = writeCase(dir, "hard-with-extras", minimalManifest({ tier: "hard", tags: ["tricky", "regression"], genuineDpMax: 0 }), minimalFiles());
  writeReference(caseDir, { "thing.ts.case": "export function f() {}\n" });

  const result = loadCases(dir);

  assertLoaded(result);
  assert.deepEqual(tierFields(result[0]), { tier: "hard", tags: ["tricky", "regression"], genuineDpMax: 0 });
});

test("loadCases_rejects_a_hard_tier_case_with_no_reference_directory", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "hard-no-reference-dir", minimalManifest({ tier: "hard", genuineDpMax: 0 }), minimalFiles());

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /hard-no-reference-dir/);
});

test("loadCases_rejects_a_hard_tier_reference_directory_missing_the_entry_file", () => {
  const dir = tempCorpusDir();
  const caseDir = writeCase(dir, "hard-reference-missing-entry", minimalManifest({ tier: "hard", genuineDpMax: 0 }), minimalFiles());
  writeReference(caseDir, { "other.ts.case": "export function g() {}\n" });

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /hard-reference-missing-entry/);
});

test("loadCases_rejects_an_easy_tier_reference_directory_missing_the_entry_file", () => {
  const dir = tempCorpusDir();
  const caseDir = writeCase(dir, "easy-reference-missing-entry", minimalManifest(), minimalFiles());
  writeReference(caseDir, { "other.ts.case": "export function g() {}\n" });

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /easy-reference-missing-entry/);
});

test("loadCases_rejects_a_reference_file_that_does_not_end_in_case", () => {
  const dir = tempCorpusDir();
  const caseDir = writeCase(dir, "reference-bad-suffix", minimalManifest(), minimalFiles());
  writeReference(caseDir, { "thing.ts.case": "export function f() {}\n", "notes.txt": "not a case file\n" });

  const result = loadCases(dir);

  assertRejected(result);
  assert.match(result.error, /reference-bad-suffix/);
});

const REFERENCE_FILES = { "thing.ts.case": "export function f() { return 1; }\n", "helper.ts.case": "export function h() { return 2; }\n" };
const EXPECTED_REFERENCE = { "thing.ts": REFERENCE_FILES["thing.ts.case"], "helper.ts": REFERENCE_FILES["helper.ts.case"] };

function writeHardCaseWithReferenceFiles(dir: string, id: string, referenceFiles: Record<string, string>): void {
  const caseDir = writeCase(dir, id, minimalManifest({ tier: "hard", genuineDpMax: 0 }), minimalFiles());
  writeReference(caseDir, referenceFiles);
}

function assertReferenceEquals(result: ReturnType<typeof loadCases>, expected: Record<string, string>): void {
  assertLoaded(result);
  assert.deepEqual(result[0]?.reference, expected);
}

test("loadCases_loads_reference_files_keyed_by_their_stripped_filename", () => {
  const dir = tempCorpusDir();
  writeHardCaseWithReferenceFiles(dir, "hard-with-reference", REFERENCE_FILES);

  const result = loadCases(dir);

  assertReferenceEquals(result, EXPECTED_REFERENCE);
});

test("loadCases_leaves_reference_undefined_when_no_reference_directory_is_present", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "easy-no-reference", minimalManifest(), minimalFiles());

  const result = loadCases(dir);

  assertLoaded(result);
  assert.equal(result[0]?.reference, undefined);
});

test("loadCases_filters_to_the_requested_ids", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "case-a", minimalManifest(), { "thing.ts.case": "export function f() {}\n" });
  writeCase(dir, "case-b", minimalManifest({ id: "case-b" }), { "thing.ts.case": "export function f() {}\n" });

  const result = loadCases(dir, ["case-b"]);

  assertLoaded(result);
  assert.deepEqual(result.map((c) => c.id), ["case-b"]);
});

function loadCaseManifest(id: string): CaseManifest {
  const result = loadCases(CORPUS_DIR, [id]);
  assertLoaded(result);
  return result[0]!;
}

function readCaseSource(id: string, filename: string): string {
  return readFileSync(join(CORPUS_DIR, id, filename), "utf8");
}

function readFixtureSource(filename: string): string {
  return readFileSync(join(FIXTURES_DIR, filename), "utf8");
}

function asProbeableLang(lang: Lang): "typescript" | "python" {
  if (lang !== "typescript" && lang !== "python") {
    throw new Error(`asProbeableLang: probes are not runnable for lang "${lang}"`);
  }
  return lang;
}

function describeProbeFailure(failure: ProbeFailure): string {
  return `probe ${failure.index}: ${failure.reason}`;
}

function assertProbesPassed(outcome: ProbeOutcome): void {
  const reasons = outcome.failures.map(describeProbeFailure).join("; ");
  assert.equal(outcome.passed, true, `probes did not pass: ${reasons}`);
}

function assertEntrySymbolFullyCovered(missingInSpan: number[], unreachableLines: number[]): void {
  assert.deepEqual(
    missingInSpan,
    unreachableLines,
    `entry symbol has uncovered lines beyond the known unreachable ones: ${missingInSpan.join(", ")}`,
  );
}

async function assertProbesAdequateForCase(id: string, unreachableLines: number[] = []): Promise<void> {
  const manifest = loadCaseManifest(id);
  const source = readCaseSource(id, `${manifest.entry}.case`);

  const { outcome, missingInSpan } = await runProbesWithCoverage({
    lang: asProbeableLang(manifest.lang),
    entryFilename: manifest.entry,
    source,
    entrySymbol: manifest.entrySymbol,
    probes: manifest.probes,
  });

  assertProbesPassed(outcome);
  assertEntrySymbolFullyCovered(missingInSpan, unreachableLines);
}

function assertProbesRejectFixture(id: string, fixtureFilename: string): void {
  const manifest = loadCaseManifest(id);
  const source = readFixtureSource(fixtureFilename);

  const outcome = runProbes({
    lang: asProbeableLang(manifest.lang),
    entryFilename: manifest.entry,
    source,
    entrySymbol: manifest.entrySymbol,
    probes: manifest.probes,
  });

  assert.equal(outcome.passed, false);
}

function assertMetricsMatchBaseline(
  functions: FunctionFacts[],
  silentHandlers: number,
  baseline: BaselineMetrics,
): void {
  assert.equal(decisionPoints(functions), baseline.decisionPoints);
  assert.equal(functions.length, baseline.functions);
  assert.equal(silentHandlers, baseline.silentHandlers);
}

async function extractTypescript(input: { path: string; after: string }) {
  return await typescriptExtractor.extract(input);
}

function assertMaxCcExceedsRailThreshold(functions: FunctionFacts[], lang: Lang): void {
  const maxCc = Math.max(...functions.map((f) => f.cyclomaticComplexity));

  assert.ok(maxCc > CC_RAIL_THRESHOLD[lang], `expected max cc ${maxCc} to exceed threshold ${CC_RAIL_THRESHOLD[lang]}`);
}

async function assertMetricsMatchBaselineForTsCase(id: string, filename: string): Promise<void> {
  const manifest = loadCaseManifest(id);
  const source = readCaseSource(id, filename);

  const extracted = await extractTypescript({ path: manifest.entry, after: source });
  const silentHandlers = countSilentHandlers(source, "typescript");

  assertMetricsMatchBaseline(extracted.functions, silentHandlers, manifest.baseline);
}

async function assertMainFunctionCcTripsRailForTsCase(id: string, filename: string): Promise<void> {
  const source = readCaseSource(id, filename);

  const extracted = await extractTypescript({ path: filename, after: source });

  assertMaxCcExceedsRailThreshold(extracted.functions, "typescript");
}

async function assertMetricsMatchBaselineForPyCase(id: string, filename: string): Promise<void> {
  const manifest = loadCaseManifest(id);
  const source = readCaseSource(id, filename);

  const extracted = await pythonExtractor.extract({ path: manifest.entry, after: source });
  const silentHandlers = countSilentHandlers(source, "python");

  assertMetricsMatchBaseline(extracted.functions, silentHandlers, manifest.baseline);
}

async function assertMainFunctionCcTripsRailForPyCase(id: string, filename: string): Promise<void> {
  const manifest = loadCaseManifest(id);
  const source = readCaseSource(id, filename);

  const extracted = await pythonExtractor.extract({ path: manifest.entry, after: source });

  assertMaxCcExceedsRailThreshold(extracted.functions, "python");
}

test("ts_flag_parser_case_metrics_match_the_committed_baseline", async () => {
  const manifest = loadCaseManifest("ts-flag-parser");
  const source = readCaseSource("ts-flag-parser", "parse_flags.ts.case");

  const extracted = await extractTypescript({ path: manifest.entry, after: source });
  const silentHandlers = countSilentHandlers(source, "typescript");

  assertMetricsMatchBaseline(extracted.functions, silentHandlers, manifest.baseline);
});

test("ts_flag_parser_case_main_function_cc_trips_the_cc_rail", async () => {
  const source = readCaseSource("ts-flag-parser", "parse_flags.ts.case");

  const extracted = await extractTypescript({ path: "parse_flags.ts", after: source });

  assertMaxCcExceedsRailThreshold(extracted.functions, "typescript");
});

test("ts_order_validator_case_metrics_match_the_committed_baseline", async () => {
  const manifest = loadCaseManifest("ts-order-validator");
  const source = readCaseSource("ts-order-validator", "validate_order.ts.case");

  const extracted = await extractTypescript({ path: manifest.entry, after: source });
  const silentHandlers = countSilentHandlers(source, "typescript");

  assertMetricsMatchBaseline(extracted.functions, silentHandlers, manifest.baseline);
});

test("ts_order_validator_case_main_function_cc_trips_the_cc_rail", async () => {
  const source = readCaseSource("ts-order-validator", "validate_order.ts.case");

  const extracted = await extractTypescript({ path: "validate_order.ts", after: source });

  assertMaxCcExceedsRailThreshold(extracted.functions, "typescript");
});

test(
  "py_status_dispatch_case_metrics_match_the_committed_baseline",
  { skip: !venvPythonAvailable() },
  async () => {
    const manifest = loadCaseManifest("py-status-dispatch");
    const source = readCaseSource("py-status-dispatch", "status.py.case");

    const extracted = await pythonExtractor.extract({ path: manifest.entry, after: source });
    const silentHandlers = countSilentHandlers(source, "python");

    assertMetricsMatchBaseline(extracted.functions, silentHandlers, manifest.baseline);
  },
);

test(
  "py_status_dispatch_case_main_function_cc_trips_the_cc_rail",
  { skip: !venvPythonAvailable() },
  async () => {
    const source = readCaseSource("py-status-dispatch", "status.py.case");

    const extracted = await pythonExtractor.extract({ path: "status.py", after: source });

    assertMaxCcExceedsRailThreshold(extracted.functions, "python");
  },
);

test(
  "py_ingest_bait_case_metrics_match_the_committed_baseline",
  { skip: !venvPythonAvailable() },
  async () => {
    const manifest = loadCaseManifest("py-ingest-bait");
    const source = readCaseSource("py-ingest-bait", "ingest.py.case");

    const extracted = await pythonExtractor.extract({ path: manifest.entry, after: source });
    const silentHandlers = countSilentHandlers(source, "python");

    assertMetricsMatchBaseline(extracted.functions, silentHandlers, manifest.baseline);
  },
);

test(
  "py_ingest_bait_case_main_function_cc_trips_the_cc_rail",
  { skip: !venvPythonAvailable() },
  async () => {
    const source = readCaseSource("py-ingest-bait", "ingest.py.case");

    const extracted = await pythonExtractor.extract({ path: "ingest.py", after: source });

    assertMaxCcExceedsRailThreshold(extracted.functions, "python");
  },
);

test("ts_grade_bands_case_metrics_match_the_committed_baseline", async () => {
  await assertMetricsMatchBaselineForTsCase("ts-grade-bands", "grade_report.ts.case");
});

test("ts_grade_bands_case_main_function_cc_trips_the_cc_rail", async () => {
  await assertMainFunctionCcTripsRailForTsCase("ts-grade-bands", "grade_report.ts.case");
});

test("ts_shipping_cost_case_metrics_match_the_committed_baseline", async () => {
  await assertMetricsMatchBaselineForTsCase("ts-shipping-cost", "shipping_cost.ts.case");
});

test("ts_shipping_cost_case_main_function_cc_trips_the_cc_rail", async () => {
  await assertMainFunctionCcTripsRailForTsCase("ts-shipping-cost", "shipping_cost.ts.case");
});

test("ts_retry_config_case_metrics_match_the_committed_baseline", async () => {
  await assertMetricsMatchBaselineForTsCase("ts-retry-config", "parse_retry_config.ts.case");
});

test("ts_retry_config_case_main_function_cc_trips_the_cc_rail", async () => {
  await assertMainFunctionCcTripsRailForTsCase("ts-retry-config", "parse_retry_config.ts.case");
});

test("ts_event_router_case_metrics_match_the_committed_baseline", async () => {
  await assertMetricsMatchBaselineForTsCase("ts-event-router", "route_event.ts.case");
});

test("ts_event_router_case_main_function_cc_trips_the_cc_rail", async () => {
  await assertMainFunctionCcTripsRailForTsCase("ts-event-router", "route_event.ts.case");
});

test("ts_booking_quote_case_metrics_match_the_committed_baseline", async () => {
  await assertMetricsMatchBaselineForTsCase("ts-booking-quote", "quote_booking.ts.case");
});

test("ts_booking_quote_case_main_function_cc_trips_the_cc_rail", async () => {
  await assertMainFunctionCcTripsRailForTsCase("ts-booking-quote", "quote_booking.ts.case");
});

test("ts_telemetry_pipeline_case_metrics_match_the_committed_baseline", async () => {
  await assertMetricsMatchBaselineForTsCase("ts-telemetry-pipeline", "process_batch.ts.case");
});

test("ts_telemetry_pipeline_case_main_function_cc_trips_the_cc_rail", async () => {
  await assertMainFunctionCcTripsRailForTsCase("ts-telemetry-pipeline", "process_batch.ts.case");
});

test(
  "py_password_strength_case_metrics_match_the_committed_baseline",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMetricsMatchBaselineForPyCase("py-password-strength", "password_strength.py.case");
  },
);

test(
  "py_password_strength_case_main_function_cc_trips_the_cc_rail",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMainFunctionCcTripsRailForPyCase("py-password-strength", "password_strength.py.case");
  },
);

test(
  "py_ticket_price_case_metrics_match_the_committed_baseline",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMetricsMatchBaselineForPyCase("py-ticket-price", "ticket_price.py.case");
  },
);

test(
  "py_ticket_price_case_main_function_cc_trips_the_cc_rail",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMainFunctionCcTripsRailForPyCase("py-ticket-price", "ticket_price.py.case");
  },
);

test(
  "py_config_loader_case_metrics_match_the_committed_baseline",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMetricsMatchBaselineForPyCase("py-config-loader", "load_config.py.case");
  },
);

test(
  "py_config_loader_case_main_function_cc_trips_the_cc_rail",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMainFunctionCcTripsRailForPyCase("py-config-loader", "load_config.py.case");
  },
);

test(
  "py_safe_convert_case_metrics_match_the_committed_baseline",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMetricsMatchBaselineForPyCase("py-safe-convert", "to_number.py.case");
  },
);

test(
  "py_safe_convert_case_main_function_cc_trips_the_cc_rail",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMainFunctionCcTripsRailForPyCase("py-safe-convert", "to_number.py.case");
  },
);

test(
  "py_membership_renewal_case_metrics_match_the_committed_baseline",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMetricsMatchBaselineForPyCase("py-membership-renewal", "renewal.py.case");
  },
);

test(
  "py_membership_renewal_case_main_function_cc_trips_the_cc_rail",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMainFunctionCcTripsRailForPyCase("py-membership-renewal", "renewal.py.case");
  },
);

test(
  "py_timeseries_qc_case_metrics_match_the_committed_baseline",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMetricsMatchBaselineForPyCase("py-timeseries-qc", "qc_series.py.case");
  },
);

test(
  "py_timeseries_qc_case_main_function_cc_trips_the_cc_rail",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertMainFunctionCcTripsRailForPyCase("py-timeseries-qc", "qc_series.py.case");
  },
);

test("ts_flag_parser_probes_pass_and_fully_cover_the_entry_symbol", async () => {
  await assertProbesAdequateForCase("ts-flag-parser");
});

test("ts_order_validator_probes_pass_and_fully_cover_the_entry_symbol", async () => {
  await assertProbesAdequateForCase("ts-order-validator");
});

test("ts_grade_bands_probes_pass_and_fully_cover_the_entry_symbol", async () => {
  await assertProbesAdequateForCase("ts-grade-bands");
});

test("ts_shipping_cost_probes_pass_and_fully_cover_the_entry_symbol", async () => {
  await assertProbesAdequateForCase("ts-shipping-cost");
});

test("ts_retry_config_probes_pass_and_fully_cover_the_entry_symbol", async () => {
  await assertProbesAdequateForCase("ts-retry-config");
});

test("ts_event_router_probes_pass_and_fully_cover_the_entry_symbol", async () => {
  await assertProbesAdequateForCase("ts-event-router");
});

test("ts_booking_quote_probes_pass_and_fully_cover_the_entry_symbol", async () => {
  await assertProbesAdequateForCase("ts-booking-quote");
});

test("ts_telemetry_pipeline_probes_pass_and_fully_cover_the_entry_symbol", async () => {
  await assertProbesAdequateForCase("ts-telemetry-pipeline");
});

test(
  "py_config_loader_probes_pass_and_fully_cover_the_entry_symbol",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertProbesAdequateForCase("py-config-loader");
  },
);

test(
  "py_ingest_bait_probes_pass_and_fully_cover_the_entry_symbol",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertProbesAdequateForCase("py-ingest-bait");
  },
);

test(
  "py_password_strength_probes_pass_and_fully_cover_the_entry_symbol",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertProbesAdequateForCase("py-password-strength");
  },
);

test(
  "py_safe_convert_probes_pass_and_fully_cover_the_entry_symbol",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertProbesAdequateForCase("py-safe-convert");
  },
);

test(
  "py_status_dispatch_probes_pass_and_fully_cover_the_entry_symbol",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertProbesAdequateForCase("py-status-dispatch");
  },
);

const TICKET_PRICE_UNREACHABLE_CLAMP_LINE = 28;

test(
  "py_ticket_price_probes_fully_cover_the_entry_symbol_except_the_unreachable_clamp",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertProbesAdequateForCase("py-ticket-price", [TICKET_PRICE_UNREACHABLE_CLAMP_LINE]);
  },
);

test(
  "py_membership_renewal_probes_pass_and_fully_cover_the_entry_symbol",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertProbesAdequateForCase("py-membership-renewal");
  },
);

test(
  "py_timeseries_qc_probes_pass_and_fully_cover_the_entry_symbol",
  { skip: !venvPythonAvailable() },
  async () => {
    await assertProbesAdequateForCase("py-timeseries-qc");
  },
);

test(
  "py_ingest_bait_probes_reject_the_validation_gutting_rewrite",
  { skip: !venvPythonAvailable() },
  () => {
    assertProbesRejectFixture("py-ingest-bait", "py-ingest-bait-gamed.py");
  },
);

function minimalReferenceProvenance(): Provenance {
  return {
    conditionId: "reference",
    phrasingPackHash: null,
    liubaiSha: "0000000",
    model: "reference-fix",
    collectedAt: "2026-01-01T00:00:00.000Z",
  };
}

function referenceRawRow(kase: CaseManifest): RawRow {
  return {
    caseId: kase.id,
    conditionId: "reference",
    rep: 1,
    provenance: minimalReferenceProvenance(),
    files: kase.reference ?? {},
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
  };
}

async function assertReferenceFixIsGenuine(corpusDir: string, caseId: string): Promise<void> {
  const cases = loadCases(corpusDir, [caseId]);
  assertLoaded(cases);
  const kase = cases[0]!;
  assert.ok(kase.reference !== undefined, `${caseId}: case has no reference snapshot to judge`);

  const [judged] = await judgeRows([referenceRawRow(kase)], corpusDir);

  assert.equal(
    judged!.judge.verdict,
    "genuine-fix",
    `${caseId}: expected reference fix to be judged genuine-fix, got ${judged!.judge.verdict}`,
  );
  assert.equal(judged!.judge.probesPassed, true, `${caseId}: expected reference fix probes to pass`);
}

function requiresUnavailableVenv(kase: CaseManifest): boolean {
  return kase.lang === "python" && !venvPythonAvailable();
}

test("every_hard_tier_reference_fix_in_the_real_corpus_is_judged_genuine", async () => {
  const cases = loadCases(CORPUS_DIR);
  assertLoaded(cases);

  for (const kase of cases.filter((c) => c.tier === "hard")) {
    if (requiresUnavailableVenv(kase)) continue;
    await assertReferenceFixIsGenuine(CORPUS_DIR, kase.id);
  }
});

function hardTierEntrySource(): string {
  return "export function f(x: number): number {\n  if (x > 0) {\n    return 1;\n  }\n  if (x < 0) {\n    return -1;\n  }\n  return 0;\n}\n";
}

function hardTierProbes(): unknown[] {
  return [
    { args: [1], returns: 1 },
    { args: [-1], returns: -1 },
    { args: [0], returns: 0 },
  ];
}

function hardTierGenuineReferenceSource(): string {
  return "export function f(x: number): number {\n  return Math.sign(x);\n}\n";
}

function hardTierBarMissedReferenceSource(): string {
  return "export function f(x: number): number {\n  return x === 0 ? 0 : Math.sign(x);\n}\n";
}

function writeHardTierCaseWithReference(dir: string, id: string, genuineDpMax: number, referenceSource: string): void {
  const manifest = minimalManifest({ id, tier: "hard", genuineDpMax, baseline: { decisionPoints: 2, functions: 1, silentHandlers: 0 } });
  const caseDir = writeCase(dir, id, manifest, { "thing.ts.case": hardTierEntrySource() }, hardTierProbes());
  writeReference(caseDir, { "thing.ts.case": referenceSource });
}

test("assertReferenceFixIsGenuine_passes_when_the_reference_clears_genuineDpMax_and_probes_pass", async () => {
  const dir = tempCorpusDir();
  writeHardTierCaseWithReference(dir, "hard-genuine", 0, hardTierGenuineReferenceSource());

  await assert.doesNotReject(() => assertReferenceFixIsGenuine(dir, "hard-genuine"));
});

test("assertReferenceFixIsGenuine_throws_when_the_reference_reduces_dp_but_stays_above_genuineDpMax", async () => {
  const dir = tempCorpusDir();
  writeHardTierCaseWithReference(dir, "hard-bar-missed", 0, hardTierBarMissedReferenceSource());

  await assert.rejects(() => assertReferenceFixIsGenuine(dir, "hard-bar-missed"));
});
