import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { promptCarriedTreatmentMessage } from "./prompt-carried-message.ts";
import type { CaseManifest } from "./eval-contract.ts";

const PLACEHOLDER_TEMPLATE = "{name} carries {dpBefore} decision points before and {dpAfter} after.";
const CC_TEMPLATE = "{name} at {cc} over {threshold}";
const UNUSED_CORPUS_DIR = "unused-corpus-dir";

const TWO_FUNCTIONS_WHERE_THE_HELPER_IS_MORE_COMPLEX = `
function simple(x: number): number {
  return x;
}

function complex(x: number): number {
  if (x > 0) {
    return 1;
  }
  if (x < 0) {
    return -1;
  }
  return 0;
}
`;

function caseManifestFixture(entrySymbol: string, decisionPoints: number): CaseManifest {
  return {
    id: "fixture-case",
    lang: "typescript",
    files: ["thing.ts.case"],
    entry: "thing.ts",
    entrySymbol,
    task: "Improve thing.ts. Keep the public function signature and behavior unchanged.",
    baseline: { decisionPoints, functions: 1, silentHandlers: 0 },
    tier: "easy",
    behaviorChecks: [{ args: [1], returns: 2 }],
  };
}

function corpusDirWithEntrySource(kase: CaseManifest, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "prompt-carried-message-corpus-"));
  const caseDir = join(dir, kase.id);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(join(caseDir, `${kase.entry}.case`), source);
  return dir;
}

test("promptCarriedTreatmentMessage_fills_the_nudge_phrasings_template_placeholders_with_the_cases_entry_symbol_and_decision_points", async () => {
  const kase = caseManifestFixture("parseFlags", 24);
  const nudgePhrasing = JSON.stringify({ CC_DELTA_NUDGE: PLACEHOLDER_TEMPLATE });

  const message = await promptCarriedTreatmentMessage(kase, nudgePhrasing, UNUSED_CORPUS_DIR);

  assert.equal(message, "parseFlags carries 24 decision points before and 24 after.");
});

test("promptCarriedTreatmentMessage_throws_instead_of_rendering_the_stock_template_when_the_nudge_phrasing_is_syntactically_invalid", async () => {
  const kase = caseManifestFixture("parseFlags", 24);

  await assert.rejects(promptCarriedTreatmentMessage(kase, "{ not json", UNUSED_CORPUS_DIR));
});

test("promptCarriedTreatmentMessage_throws_instead_of_rendering_the_stock_template_when_the_nudge_phrasing_is_semantically_invalid", async () => {
  const kase = caseManifestFixture("parseFlags", 24);
  const nudgePhrasing = JSON.stringify({ CC_DELTA_NUDGE: 42 });

  await assert.rejects(promptCarriedTreatmentMessage(kase, nudgePhrasing, UNUSED_CORPUS_DIR));
});

test("promptCarriedTreatmentMessage_pinning_cc_nudge_names_the_most_complex_function_of_the_starting_file_not_the_entry_symbol", async () => {
  const kase = caseManifestFixture("simple", 5);
  const corpusDir = corpusDirWithEntrySource(kase, TWO_FUNCTIONS_WHERE_THE_HELPER_IS_MORE_COMPLEX);
  const nudgePhrasing = JSON.stringify({ CC_NUDGE: { typescript: { first: CC_TEMPLATE, rest: CC_TEMPLATE } } });

  const message = await promptCarriedTreatmentMessage(kase, nudgePhrasing, corpusDir);

  assert.equal(message, "complex at 3 over 8");
});

test("promptCarriedTreatmentMessage_pinning_cc_nudge_without_the_cases_language_throws", async () => {
  const kase = caseManifestFixture("simple", 5);
  const corpusDir = corpusDirWithEntrySource(kase, TWO_FUNCTIONS_WHERE_THE_HELPER_IS_MORE_COMPLEX);
  const nudgePhrasing = JSON.stringify({ CC_NUDGE: { python: { first: CC_TEMPLATE, rest: CC_TEMPLATE } } });

  await assert.rejects(promptCarriedTreatmentMessage(kase, nudgePhrasing, corpusDir));
});
