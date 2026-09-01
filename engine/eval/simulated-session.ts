import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CaseManifest } from "./eval-contract.ts";

function priorDraftFilename(kase: CaseManifest): string {
  return `prior-draft.${kase.lang === "python" ? "py" : "ts"}`;
}

export function priorDraftPath(corpusDir: string, kase: CaseManifest): string {
  return join(corpusDir, kase.id, priorDraftFilename(kase));
}

export interface SimulatedSessionInputs {
  priorDraft: string;
  extensionTask: string;
}

export function loadSimulatedSessionInputs(corpusDir: string, kase: CaseManifest): SimulatedSessionInputs | { error: string } {
  const draftPath = priorDraftPath(corpusDir, kase);
  if (!existsSync(draftPath)) {
    return { error: `${kase.id}: simulated-session mode requires ${priorDraftFilename(kase)} in the case's corpus directory` };
  }
  if (kase.extension === undefined) {
    return { error: `${kase.id}: simulated-session mode requires extension.json in the case's corpus directory` };
  }
  return { priorDraft: readFileSync(draftPath, "utf8"), extensionTask: kase.extension.task };
}

export function simulatedSessionOpeningTask(kase: CaseManifest, priorDraft: string, extensionTask: string): string {
  return [
    "This is a simulated work session for research purposes.",
    "",
    `Write the draft below to ${kase.entry}, exactly as shown, and treat it as code you wrote earlier in this session.`,
    "",
    priorDraft,
    "",
    "Now do the following:",
    "",
    extensionTask,
  ].join("\n");
}

export function buildSimulatedSessionTask(corpusDir: string, kase: CaseManifest): { task: string } | { error: string } {
  const inputs = loadSimulatedSessionInputs(corpusDir, kase);
  if ("error" in inputs) return inputs;
  return { task: simulatedSessionOpeningTask(kase, inputs.priorDraft, inputs.extensionTask) };
}

export function missingSimulatedSessionInputs(corpusDir: string, cases: CaseManifest[]): string | undefined {
  for (const kase of cases) {
    const inputs = loadSimulatedSessionInputs(corpusDir, kase);
    if ("error" in inputs) return inputs.error;
  }
  return undefined;
}
