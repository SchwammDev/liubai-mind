import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { RULE } from "../contract.ts";
import type { CaseManifest, RawRow } from "./eval-contract.ts";
import { decisionPoints } from "./judge.ts";
import { loadSimulatedSessionInputs } from "./simulated-session.ts";
import { runProbes } from "./probes.ts";
import { sourceParses } from "./parse-check.ts";
import { typescriptExtractor } from "../extract-typescript.ts";
import { pythonExtractor } from "../extract-python.ts";

const SUMMARY_FILENAME = "summary.jsonl";
const OK_STATUS = 0;
const ERROR_STATUS = 1;

export interface SimulatedSessionSummaryRow {
  conditionId: string;
  fired: number;
  corrected: number;
  total: number;
  meanFinalDp: number | null;
}

export function isSimulatedSessionRun(rows: RawRow[]): boolean {
  return rows.some((row) => row.simulatedSession === true);
}

function ccDeltaFirings(row: RawRow): number {
  return (row.railFirings?.[RULE.ccDelta] ?? 0) + (row.shadowFirings?.[RULE.ccDelta] ?? 0);
}

export function repFired(row: RawRow): boolean {
  return ccDeltaFirings(row) >= 1;
}

function probeLangFor(lang: CaseManifest["lang"]): "typescript" | "python" {
  if (lang === "typescript") return "typescript";
  if (lang === "python") return "python";
  throw new Error(`simulated-session score: unsupported lang for probe running: ${lang}`);
}

function extractorFor(lang: CaseManifest["lang"]) {
  return lang === "python" ? pythonExtractor : typescriptExtractor;
}

async function fileDecisionPoints(kase: CaseManifest, source: string): Promise<number | undefined> {
  if (!sourceParses(source, probeLangFor(kase.lang))) return undefined;
  const extracted = await extractorFor(kase.lang).extract({ path: kase.entry, after: source });
  return decisionPoints(extracted.functions);
}

function probesPassAgainst(kase: CaseManifest, finalSource: string, files: Record<string, string>): boolean {
  const extension = kase.extension;
  if (extension === undefined) {
    throw new Error(`simulated-session score: case ${kase.id} has no extension.json`);
  }

  const caseOutcome = runProbes({
    lang: probeLangFor(kase.lang),
    entryFilename: kase.entry,
    source: finalSource,
    entrySymbol: kase.entrySymbol,
    probes: kase.probes,
    files,
    compare: "subset",
  });
  if (!caseOutcome.passed) return false;

  return runProbes({
    lang: probeLangFor(kase.lang),
    entryFilename: kase.entry,
    source: finalSource,
    entrySymbol: kase.entrySymbol,
    probes: extension.probes,
    files,
    compare: "subset",
  }).passed;
}

export function finalEntryIsCorrected(
  kase: CaseManifest,
  finalSource: string,
  files: Record<string, string>,
  finalDecisionPoints: number,
  draftDecisionPoints: number,
): boolean {
  if (finalDecisionPoints >= draftDecisionPoints) return false;
  return probesPassAgainst(kase, finalSource, files);
}

export interface RepJudgement {
  fired: boolean;
  corrected: boolean;
  finalDecisionPoints: number | undefined;
}

export async function judgeSimulatedSessionRep(kase: CaseManifest, row: RawRow, draftDecisionPoints: number): Promise<RepJudgement> {
  const fired = repFired(row);
  if (!fired) return { fired: false, corrected: false, finalDecisionPoints: undefined };

  const finalSource = row.files[kase.entry];
  if (finalSource === undefined) return { fired: true, corrected: false, finalDecisionPoints: undefined };

  const finalDecisionPoints = await fileDecisionPoints(kase, finalSource);
  if (finalDecisionPoints === undefined) return { fired: true, corrected: false, finalDecisionPoints: undefined };

  const corrected = finalEntryIsCorrected(kase, finalSource, row.files, finalDecisionPoints, draftDecisionPoints);
  return { fired: true, corrected, finalDecisionPoints };
}

function rowLabel(row: RawRow): string {
  return `${row.conditionId}/${row.caseId}#${row.rep}`;
}

function hasFilesSnapshot(row: RawRow): boolean {
  return typeof row.files === "object" && row.files !== null;
}

function findCase(cases: CaseManifest[], caseId: string): CaseManifest {
  const kase = cases.find((c) => c.id === caseId);
  if (kase === undefined) throw new Error(`simulated-session score: unknown case id in raw row: ${caseId}`);
  return kase;
}

async function draftDecisionPointsFor(corpusDir: string, kase: CaseManifest): Promise<number> {
  const inputs = loadSimulatedSessionInputs(corpusDir, kase);
  if ("error" in inputs) throw new Error(`simulated-session score: ${inputs.error}`);

  const dp = await fileDecisionPoints(kase, inputs.priorDraft);
  if (dp === undefined) throw new Error(`simulated-session score: prior-draft for case ${kase.id} does not parse`);
  return dp;
}

function draftDecisionPointsCache(corpusDir: string): (kase: CaseManifest) => Promise<number> {
  const cache = new Map<string, Promise<number>>();
  return (kase) => {
    const cached = cache.get(kase.id);
    if (cached !== undefined) return cached;
    const computed = draftDecisionPointsFor(corpusDir, kase);
    cache.set(kase.id, computed);
    return computed;
  };
}

interface ConditionAccumulator {
  fired: number;
  corrected: number;
  total: number;
  finalDpSum: number;
  finalDpCount: number;
}

function newAccumulator(): ConditionAccumulator {
  return { fired: 0, corrected: 0, total: 0, finalDpSum: 0, finalDpCount: 0 };
}

function addRep(acc: ConditionAccumulator, judgement: RepJudgement): void {
  acc.total += 1;
  if (!judgement.fired) return;

  acc.fired += 1;
  if (judgement.corrected) acc.corrected += 1;
  if (judgement.finalDecisionPoints !== undefined) {
    acc.finalDpSum += judgement.finalDecisionPoints;
    acc.finalDpCount += 1;
  }
}

function finalizeAccumulator(conditionId: string, acc: ConditionAccumulator): SimulatedSessionSummaryRow {
  return {
    conditionId,
    fired: acc.fired,
    corrected: acc.corrected,
    total: acc.total,
    meanFinalDp: acc.finalDpCount === 0 ? null : acc.finalDpSum / acc.finalDpCount,
  };
}

export async function summarizeSimulatedSession(rows: RawRow[], cases: CaseManifest[], corpusDir: string): Promise<SimulatedSessionSummaryRow[]> {
  const missingSnapshot = rows.find((row) => !hasFilesSnapshot(row));
  if (missingSnapshot !== undefined) {
    throw new Error(`simulated-session score: ${rowLabel(missingSnapshot)} has no files snapshot; simulated-session scoring requires one`);
  }

  const draftDpFor = draftDecisionPointsCache(corpusDir);
  const buckets = new Map<string, ConditionAccumulator>();

  for (const row of rows) {
    const kase = findCase(cases, row.caseId);
    const draftDp = await draftDpFor(kase);
    const judgement = await judgeSimulatedSessionRep(kase, row, draftDp);

    const acc = buckets.get(row.conditionId) ?? newAccumulator();
    addRep(acc, judgement);
    buckets.set(row.conditionId, acc);
  }

  return [...buckets.entries()].map(([conditionId, acc]) => finalizeAccumulator(conditionId, acc));
}

function formatMeanFinalDp(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function formatSimulatedSessionLine(row: SimulatedSessionSummaryRow): string {
  return `  ${row.conditionId}: fired=${row.fired}/${row.total} corrected=${row.corrected}/${row.fired} meanFinalDp=${formatMeanFinalDp(row.meanFinalDp)}`;
}

export function formatSimulatedSessionBlock(summary: SimulatedSessionSummaryRow[]): string {
  return [`simulated-session validity:`, ...summary.map(formatSimulatedSessionLine), ""].join("\n");
}

function writeSimulatedSessionSummaryJsonl(runDir: string, summary: SimulatedSessionSummaryRow[]): void {
  const content = summary.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(runDir, SUMMARY_FILENAME), content);
}

export async function runSimulatedSessionScore(
  rows: RawRow[],
  cases: CaseManifest[],
  corpusDir: string,
  runDir: string,
): Promise<{ status: number; stdout: string }> {
  let summary: SimulatedSessionSummaryRow[];
  try {
    summary = await summarizeSimulatedSession(rows, cases, corpusDir);
  } catch (err) {
    return { status: ERROR_STATUS, stdout: err instanceof Error ? err.message : String(err) };
  }

  writeSimulatedSessionSummaryJsonl(runDir, summary);
  return { status: OK_STATUS, stdout: formatSimulatedSessionBlock(summary) };
}
