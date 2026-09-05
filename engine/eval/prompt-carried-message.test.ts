import { test } from "node:test";
import assert from "node:assert/strict";

import { promptCarriedTreatmentMessage } from "./prompt-carried-message.ts";
import type { CaseManifest } from "./eval-contract.ts";

const PLACEHOLDER_TEMPLATE = "{name} carries {dpBefore} decision points before and {dpAfter} after.";

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

test("promptCarriedTreatmentMessage_fills_the_pack_templates_placeholders_with_the_cases_entry_symbol_and_decision_points", () => {
  const kase = caseManifestFixture("parseFlags", 24);
  const packContent = JSON.stringify({ CC_DELTA_NUDGE: PLACEHOLDER_TEMPLATE });

  const message = promptCarriedTreatmentMessage(kase, packContent);

  assert.equal(message, "parseFlags carries 24 decision points before and 24 after.");
});

test("promptCarriedTreatmentMessage_throws_instead_of_rendering_the_stock_template_when_the_pack_content_is_syntactically_invalid", () => {
  const kase = caseManifestFixture("parseFlags", 24);

  assert.throws(() => promptCarriedTreatmentMessage(kase, "{ not json"));
});

test("promptCarriedTreatmentMessage_throws_instead_of_rendering_the_stock_template_when_the_pack_content_is_semantically_invalid", () => {
  const kase = caseManifestFixture("parseFlags", 24);
  const packContent = JSON.stringify({ CC_DELTA_NUDGE: 42 });

  assert.throws(() => promptCarriedTreatmentMessage(kase, packContent));
});
