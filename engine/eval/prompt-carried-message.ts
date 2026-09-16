import type { CaseManifest } from "./eval-contract.ts";
import { ccDeltaTextFor } from "./canary.ts";
import { validateNudgePhrasing } from "./phrasing.ts";
import type { NudgePhrasing } from "./phrasing.ts";
import { formatCcDeltaNudge } from "../messages.ts";

function treatmentPhrasing(nudgePhrasing: string): NudgePhrasing {
  const validated = validateNudgePhrasing(nudgePhrasing);
  if ("error" in validated) {
    throw new Error(
      `promptCarriedTreatmentMessage: nudge phrasing failed validation (${validated.error}) — this nudge phrasing was validated at treatment load time, so an invalid one here means that validation regressed`,
    );
  }
  return validated.phrasing;
}

export function promptCarriedTreatmentMessage(kase: CaseManifest, nudgePhrasing: string): string {
  const template = ccDeltaTextFor(treatmentPhrasing(nudgePhrasing));
  return formatCcDeltaNudge(template, {
    name: kase.entrySymbol,
    dpBefore: kase.baseline.decisionPoints,
    dpAfter: kase.baseline.decisionPoints,
  });
}
