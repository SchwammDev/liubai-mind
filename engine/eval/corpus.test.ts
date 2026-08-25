import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { loadCases, copyPlan } from "./corpus.ts";
import type { CaseManifest, BaselineMetrics } from "./eval-contract.ts";
import { decisionPoints } from "./judge.ts";
import { countSilentHandlers } from "./silent-handlers.ts";
import { typescriptExtractor } from "../extract-typescript.ts";
import { pythonExtractor } from "../extract-python.ts";
import type { FunctionFacts, Lang } from "../contract.ts";
import { DEFAULT_POLICY, RULE } from "../policy.ts";

const CORPUS_DIR = join(import.meta.dirname, "corpus");
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

function minimalManifest(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "case-a",
    lang: "typescript",
    files: ["thing.ts.case"],
    entry: "thing.ts",
    entrySymbol: "f",
    task: "Improve thing.ts. Keep the public function signature and behavior unchanged.",
    baseline: { decisionPoints: 1, functions: 1, silentHandlers: 0 },
    ...over,
  };
}

test("loadCases_loads_all_twelve_committed_cases", () => {
  const result = loadCases(CORPUS_DIR);

  assertLoaded(result);
  const ids = result.map((c) => c.id).sort();
  assert.deepEqual(ids, [
    "py-config-loader",
    "py-ingest-bait",
    "py-password-strength",
    "py-safe-convert",
    "py-status-dispatch",
    "py-ticket-price",
    "ts-event-router",
    "ts-flag-parser",
    "ts-grade-bands",
    "ts-order-validator",
    "ts-retry-config",
    "ts-shipping-cost",
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

test("loadCases_filters_to_the_requested_ids", () => {
  const dir = tempCorpusDir();
  writeCase(dir, "case-a", minimalManifest(), { "thing.ts.case": "export function f() {}\n" });
  writeCase(dir, "case-b", minimalManifest({ id: "case-b" }), { "thing.ts.case": "export function f() {}\n" });

  const result = loadCases(dir, ["case-b"]);

  assertLoaded(result);
  assert.deepEqual(result.map((c) => c.id), ["case-b"]);
});

function python3Available(): boolean {
  const res = spawnSync("python3", ["--version"]);
  return res.error === undefined && res.status === 0;
}

function loadCaseManifest(id: string): CaseManifest {
  const result = loadCases(CORPUS_DIR, [id]);
  assertLoaded(result);
  return result[0]!;
}

function readCaseSource(id: string, filename: string): string {
  return readFileSync(join(CORPUS_DIR, id, filename), "utf8");
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
  const source = readCaseSource(id, filename);

  const extracted = await pythonExtractor.extract({ path: filename, after: source });

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
  { skip: !python3Available() },
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
  { skip: !python3Available() },
  async () => {
    const source = readCaseSource("py-status-dispatch", "status.py.case");

    const extracted = await pythonExtractor.extract({ path: "status.py", after: source });

    assertMaxCcExceedsRailThreshold(extracted.functions, "python");
  },
);

test(
  "py_ingest_bait_case_metrics_match_the_committed_baseline",
  { skip: !python3Available() },
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
  { skip: !python3Available() },
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

test(
  "py_password_strength_case_metrics_match_the_committed_baseline",
  { skip: !python3Available() },
  async () => {
    await assertMetricsMatchBaselineForPyCase("py-password-strength", "password_strength.py.case");
  },
);

test(
  "py_password_strength_case_main_function_cc_trips_the_cc_rail",
  { skip: !python3Available() },
  async () => {
    await assertMainFunctionCcTripsRailForPyCase("py-password-strength", "password_strength.py.case");
  },
);

test(
  "py_ticket_price_case_metrics_match_the_committed_baseline",
  { skip: !python3Available() },
  async () => {
    await assertMetricsMatchBaselineForPyCase("py-ticket-price", "ticket_price.py.case");
  },
);

test(
  "py_ticket_price_case_main_function_cc_trips_the_cc_rail",
  { skip: !python3Available() },
  async () => {
    await assertMainFunctionCcTripsRailForPyCase("py-ticket-price", "ticket_price.py.case");
  },
);

test(
  "py_config_loader_case_metrics_match_the_committed_baseline",
  { skip: !python3Available() },
  async () => {
    await assertMetricsMatchBaselineForPyCase("py-config-loader", "load_config.py.case");
  },
);

test(
  "py_config_loader_case_main_function_cc_trips_the_cc_rail",
  { skip: !python3Available() },
  async () => {
    await assertMainFunctionCcTripsRailForPyCase("py-config-loader", "load_config.py.case");
  },
);

test(
  "py_safe_convert_case_metrics_match_the_committed_baseline",
  { skip: !python3Available() },
  async () => {
    await assertMetricsMatchBaselineForPyCase("py-safe-convert", "to_number.py.case");
  },
);

test(
  "py_safe_convert_case_main_function_cc_trips_the_cc_rail",
  { skip: !python3Available() },
  async () => {
    await assertMainFunctionCcTripsRailForPyCase("py-safe-convert", "to_number.py.case");
  },
);
