import type { FunctionFacts, Lang } from "../contract.ts";
import { RULE } from "../contract.ts";
import { formatCcDeltaNudge, formatCcNudge } from "../messages.ts";
import { DEFAULT_POLICY } from "../policy.ts";

import type { CaseManifest } from "./eval-contract.ts";
import { extractFunctions, readEntrySource } from "./case-source.ts";
import { validateNudgePhrasing } from "./phrasing.ts";
import type { CcNudgeEntry, NudgePhrasing } from "./phrasing.ts";

function treatmentPhrasing(nudgePhrasing: string): NudgePhrasing {
  const validated = validateNudgePhrasing(nudgePhrasing);
  if ("error" in validated) {
    throw new Error(
      `promptCarriedTreatmentMessage: nudge phrasing failed validation (${validated.error}) — this nudge phrasing was validated at treatment load time, so an invalid one here means that validation regressed`,
    );
  }
  return validated.phrasing;
}

function mostComplexFunction(functions: FunctionFacts[]): FunctionFacts {
  if (functions.length === 0) {
    throw new Error("promptCarriedTreatmentMessage: starting entry file has no functions to name in a CC_NUDGE message");
  }
  return functions.reduce((max, fn) => (fn.cyclomaticComplexity > max.cyclomaticComplexity ? fn : max));
}

function ccDeltaMessage(kase: CaseManifest, template: string): string {
  return formatCcDeltaNudge(template, {
    name: kase.entrySymbol,
    dpBefore: kase.baseline.decisionPoints,
    dpAfter: kase.baseline.decisionPoints,
  });
}

async function ccNudgeMessage(kase: CaseManifest, ccNudge: Partial<Record<Lang, CcNudgeEntry>>, corpusDir: string): Promise<string> {
  const entry = ccNudge[kase.lang];
  if (entry === undefined) {
    throw new Error(`promptCarriedTreatmentMessage: nudge phrasing pins CC_NUDGE but has no entry for lang ${kase.lang}`);
  }

  const source = readEntrySource(corpusDir, kase);
  const extracted = await extractFunctions(kase.lang, kase.entry, source);
  const fn = mostComplexFunction(extracted.functions);

  const threshold = DEFAULT_POLICY[RULE.cc].threshold?.[kase.lang];
  if (threshold === undefined) {
    throw new Error(`promptCarriedTreatmentMessage: cc rule carries no threshold for lang ${kase.lang}`);
  }

  return formatCcNudge(entry.first, { name: fn.name, cc: fn.cyclomaticComplexity, threshold });
}

export async function promptCarriedTreatmentMessage(kase: CaseManifest, nudgePhrasing: string, corpusDir: string): Promise<string> {
  const phrasing = treatmentPhrasing(nudgePhrasing);

  if (phrasing.CC_NUDGE !== undefined) return ccNudgeMessage(kase, phrasing.CC_NUDGE, corpusDir);
  if (phrasing.CC_DELTA_NUDGE !== undefined) return ccDeltaMessage(kase, phrasing.CC_DELTA_NUDGE);

  throw new Error(
    `promptCarriedTreatmentMessage: nudge phrasing pins neither CC_NUDGE nor CC_DELTA_NUDGE — this should have been rejected at treatment load time`,
  );
}
