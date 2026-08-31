import { test } from "node:test";
import assert from "node:assert/strict";

import { promptCarriedArmMessage } from "./prompt-carried-message.ts";
import type { CaseManifest } from "./eval-contract.ts";
import { CC_DELTA_NUDGE, formatCcDeltaNudge } from "../messages.ts";

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
    probes: [{ args: [1], returns: 2 }],
  };
}

test("promptCarriedArmMessage_fills_the_pack_templates_placeholders_with_the_cases_entry_symbol_and_decision_points", () => {
  const kase = caseManifestFixture("parseFlags", 24);
  const packContent = JSON.stringify({ CC_DELTA_NUDGE: PLACEHOLDER_TEMPLATE });

  const message = promptCarriedArmMessage(kase, packContent);

  assert.equal(message, "parseFlags carries 24 decision points before and 24 after.");
});

test("promptCarriedArmMessage_falls_back_to_the_stock_template_when_the_condition_carries_no_pack", () => {
  const kase = caseManifestFixture("parseFlags", 24);

  const message = promptCarriedArmMessage(kase, undefined);

  assert.equal(message, formatCcDeltaNudge(CC_DELTA_NUDGE, { name: "parseFlags", dpBefore: 24, dpAfter: 24 }));
});
