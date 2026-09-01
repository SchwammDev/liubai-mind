import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadCases } from "./corpus.ts";
import type { CaseManifest } from "./eval-contract.ts";
import { runProbes } from "./probes.ts";
import { probeLang } from "./score.ts";
import { decisionPoints } from "./judge.ts";
import { pythonExtractor } from "../extract-python.ts";
import { typescriptExtractor } from "../extract-typescript.ts";
import type { Env, Extracted, Extractor, Lang } from "../contract.ts";
import { analyze } from "../analyze.ts";
import { buildRules, DEFAULT_POLICY } from "../policy.ts";
import { RULE } from "../contract.ts";

const CORPUS_DIR = join(import.meta.dirname, "corpus");
const CC_DELTA_THRESHOLD = DEFAULT_POLICY[RULE.ccDelta].threshold!;

const HARD_CASE_IDS = [
  "py-grid-accumulate",
  "py-membership-renewal",
  "py-timeseries-qc",
  "ts-booking-quote",
  "ts-order-fulfillment",
  "ts-telemetry-pipeline",
];

const CASES_WHOSE_DRAFT_KEEPS_DECISION_POINTS_EXACTLY_AT_BASELINE = [
  "py-membership-renewal",
  "py-timeseries-qc",
  "ts-booking-quote",
  "ts-telemetry-pipeline",
];

const CASES_WHOSE_ABORT_THROUGH_A_LOOP_COSTS_ONE_RELOCATED_DECISION = [
  "py-grid-accumulate",
  "ts-order-fulfillment",
];

function extractorFor(lang: Lang): Extractor {
  return lang === "python" ? pythonExtractor : typescriptExtractor;
}

function loadHardCase(id: string): CaseManifest {
  const result = loadCases(CORPUS_DIR, [id]);
  assert.ok(Array.isArray(result), `corpus failed to load ${id}`);
  return (result as CaseManifest[])[0]!;
}

function draftPath(kase: CaseManifest): string {
  const ext = kase.lang === "python" ? "py" : "ts";
  return join(CORPUS_DIR, kase.id, `prior-draft.${ext}`);
}

function originalSource(kase: CaseManifest): string {
  return readFileSync(join(CORPUS_DIR, kase.id, `${kase.entry}.case`), "utf8");
}

function draftSource(kase: CaseManifest): string {
  return readFileSync(draftPath(kase), "utf8");
}

async function extractedAfter(kase: CaseManifest, draft: string): Promise<Extracted> {
  return await extractorFor(kase.lang).extract({ path: kase.entry, before: originalSource(kase), after: draft });
}

function assertDraftFileExists(kase: CaseManifest): void {
  assert.ok(existsSync(draftPath(kase)), `${kase.id}: prior-draft is missing`);
}

async function assertFileDecisionPointsMatchBaselineExactly(kase: CaseManifest): Promise<void> {
  const extracted = await extractedAfter(kase, draftSource(kase));
  assert.equal(
    decisionPoints(extracted.functions),
    kase.baseline.decisionPoints,
    `${kase.id}: draft's total decision points drifted from baseline`,
  );
}

async function assertFileDecisionPointsMatchBaselinePlusOneRelocatedCheck(kase: CaseManifest): Promise<void> {
  const extracted = await extractedAfter(kase, draftSource(kase));
  assert.equal(
    decisionPoints(extracted.functions),
    kase.baseline.decisionPoints + 1,
    `${kase.id}: draft's total decision points is not exactly baseline plus the one relocated abort check`,
  );
}

async function assertEntrySymbolClearsTheThreshold(kase: CaseManifest): Promise<void> {
  const extracted = await extractedAfter(kase, draftSource(kase));
  const entryFn = extracted.functions.find((fn) => fn.name === kase.entrySymbol);
  assert.ok(entryFn !== undefined, `${kase.id}: entry symbol ${kase.entrySymbol} not found in draft`);
  assert.ok(
    entryFn!.cyclomaticComplexity < CC_DELTA_THRESHOLD[kase.lang]!,
    `${kase.id}: entry symbol did not drop below the cc-delta threshold`,
  );
}

async function assertEveryFunctionIsAtOrUnderTheThreshold(kase: CaseManifest): Promise<void> {
  const extracted = await extractedAfter(kase, draftSource(kase));
  const overThreshold = extracted.functions.filter((fn) => fn.cyclomaticComplexity > CC_DELTA_THRESHOLD[kase.lang]!);
  assert.deepEqual(
    overThreshold.map((fn) => fn.name),
    [],
    `${kase.id}: draft still has a function over the cc-delta threshold`,
  );
}

async function ccDeltaNudgesFor(kase: CaseManifest) {
  const rules = buildRules(DEFAULT_POLICY, kase.lang);
  const env: Env = { extractors: { [kase.lang]: extractorFor(kase.lang) } };
  const resp = await analyze(
    { path: kase.entry, before: originalSource(kase), after: draftSource(kase) },
    env,
    rules,
  );
  return resp.nudges.filter((n) => n.rule === RULE.ccDelta);
}

async function assertEditFiresCcDelta(kase: CaseManifest): Promise<void> {
  const fired = await ccDeltaNudgesFor(kase);
  assert.equal(fired.length, 1, `${kase.id}: prior-draft edit did not deterministically fire cc-delta`);
}

function assertDraftProbesPassLikeTheOriginal(kase: CaseManifest): void {
  const outcome = runProbes({
    lang: probeLang(kase.lang),
    entryFilename: kase.entry,
    source: draftSource(kase),
    entrySymbol: kase.entrySymbol,
    probes: kase.probes,
  });
  assert.ok(outcome.passed, `${kase.id}: draft probe failures: ${JSON.stringify(outcome.failures)}`);
}

for (const id of HARD_CASE_IDS) {
  test(`${id}_prior_draft_exists`, () => {
    assertDraftFileExists(loadHardCase(id));
  });

  test(`${id}_prior_draft_drops_the_entry_symbol_below_the_cc_delta_threshold`, async () => {
    await assertEntrySymbolClearsTheThreshold(loadHardCase(id));
  });

  test(`${id}_prior_draft_leaves_no_function_over_the_cc_delta_threshold`, async () => {
    await assertEveryFunctionIsAtOrUnderTheThreshold(loadHardCase(id));
  });

  test(`${id}_prior_draft_edit_deterministically_fires_cc_delta`, async () => {
    await assertEditFiresCcDelta(loadHardCase(id));
  });

  test(`${id}_prior_draft_behaves_identically_to_the_original_on_every_probe`, () => {
    assertDraftProbesPassLikeTheOriginal(loadHardCase(id));
  });
}

for (const id of CASES_WHOSE_DRAFT_KEEPS_DECISION_POINTS_EXACTLY_AT_BASELINE) {
  test(`${id}_prior_draft_keeps_the_files_total_decision_points_at_baseline`, async () => {
    await assertFileDecisionPointsMatchBaselineExactly(loadHardCase(id));
  });
}

for (const id of CASES_WHOSE_ABORT_THROUGH_A_LOOP_COSTS_ONE_RELOCATED_DECISION) {
  test(`${id}_prior_draft_pins_the_files_total_decision_points_to_baseline_plus_one`, async () => {
    await assertFileDecisionPointsMatchBaselinePlusOneRelocatedCheck(loadHardCase(id));
  });
}
