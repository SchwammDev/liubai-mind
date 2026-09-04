import type { CaseManifest } from "./eval-contract.ts";
import { ccDeltaTextFor } from "./canary.ts";
import { validatePack } from "./phrasing.ts";
import type { ValidPack } from "./phrasing.ts";
import { formatCcDeltaNudge } from "../messages.ts";

function armPack(packContent: string): ValidPack {
  const validated = validatePack(packContent);
  if ("error" in validated) {
    throw new Error(
      `promptCarriedArmMessage: pack content failed validation (${validated.error}) — this pack was validated at treatment load time, so an invalid pack here means that validation regressed`,
    );
  }
  return validated.pack;
}

export function promptCarriedArmMessage(kase: CaseManifest, packContent: string): string {
  const template = ccDeltaTextFor(armPack(packContent));
  return formatCcDeltaNudge(template, {
    name: kase.entrySymbol,
    dpBefore: kase.baseline.decisionPoints,
    dpAfter: kase.baseline.decisionPoints,
  });
}
