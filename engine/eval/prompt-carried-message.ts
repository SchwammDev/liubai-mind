import type { CaseManifest } from "./eval-contract.ts";
import { ccDeltaTextFor } from "./canary.ts";
import { validatePack } from "./phrasing.ts";
import type { ValidPack } from "./phrasing.ts";
import { formatCcDeltaNudge } from "../messages.ts";

function armPack(packContent: string | undefined): ValidPack {
  if (packContent === undefined) return {};
  const validated = validatePack(packContent);
  return "pack" in validated ? validated.pack : {};
}

export function promptCarriedArmMessage(kase: CaseManifest, packContent: string | undefined): string {
  const template = ccDeltaTextFor(armPack(packContent));
  return formatCcDeltaNudge(template, {
    name: kase.entrySymbol,
    dpBefore: kase.baseline.decisionPoints,
    dpAfter: kase.baseline.decisionPoints,
  });
}
