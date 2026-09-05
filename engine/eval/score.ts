import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Lang, Extracted, RuleName } from "../contract.ts";
import { RULE } from "../contract.ts";
import type { CaseManifest, TreatmentManifest } from "./eval-contract.ts";
import type { RawRow, Metrics, Verdict, GamedReason, JudgeResult, Provenance, Tier } from "./eval-contract.ts";
import { decisionPoints, classifyVerdict } from "./judge.ts";
import { countSilentHandlers } from "./silent-handlers.ts";
import { loadCases, declaredFiles } from "./corpus.ts";
import { loadTreatments } from "./treatments.ts";
import { promptCarriedTreatmentMessage } from "./prompt-carried-message.ts";
import { runBehaviorChecks } from "./behavior-checks.ts";
import type { BehaviorCheckOutcome } from "./behavior-checks.ts";
import { scanReferences } from "./references.ts";
import { sourceParses } from "./parse-check.ts";
import { typescriptExtractor } from "../extract-typescript.ts";
import { pythonExtractor } from "../extract-python.ts";
import { probePyCcBackend } from "./judge-env.ts";
import { gitSha } from "./provenance.ts";
import { classifyTranscript } from "./contamination.ts";
import { sourceDiffCounts } from "./diff-counts.ts";
import { buildRepetitionRecord } from "./repetition-record.ts";
import type { RepetitionRecord, StartsFrom } from "./repetition-record.ts";

export interface JudgedRow {
  row: RawRow;
  judge: JudgeResult;
  contaminated: boolean;
  consultedRail: boolean;
  entryChanged: boolean;
  entrySymbolComplexityBefore: number | null;
  entrySymbolComplexityAfter: number | null;
  linesAdded: number;
  linesRemoved: number;
}

export interface JudgeEnv {
  judgedAtSha: string;
  pyCcBackend: string;
}

export interface SummaryRow {
  treatmentId: string;
  caseId: string | null;
  tier: Tier | null;
  counts: Record<Verdict, number>;
  gamedReasons: Record<GamedReason, number>;
  total: number;
  withCreatedFiles: number;
  contaminated: number;
  railConsults: number;
  meanDpReduction: number | null;
  meanDurationMs: number | null;
  meanTurns: number | null;
  meanTokensIn: number | null;
  meanTokensOut: number | null;
  meanNudges: Record<RuleName, number> | null;
  costAvailable: number;
  judgedAtSha: string;
  pyCcBackend: string;
}

const VERDICTS: readonly Verdict[] = ["genuine-fix", "gamed", "bar-missed", "untouched", "broken", "behavior-broken", "errored", "timed-out"];
const GAMED_REASONS: readonly GamedReason[] = ["helper-split", "silent-handler"];
const SUMMARY_FILENAME = "summary.jsonl";
export const JUDGED_FILENAME = "judged.jsonl";
const RAW_FILENAME = "raw.jsonl";
const ERROR_STATUS = 1;
const OK_STATUS = 0;
const FALLBACK_AGENT_ERROR = "agent error";
const REPO_ROOT = join(import.meta.dirname, "..", "..");
export const ANSWER_KEY_PREFIXES = [join(REPO_ROOT, "engine", "eval"), ".pi/agent/engine/eval"];
export const RAIL_PATH_PREFIXES = [REPO_ROOT, "/.pi/", "~/.pi"];
const DEFAULT_TREATMENTS_DIR = join(import.meta.dirname, "treatments");

function silentHandlerLang(lang: Lang): "typescript" | "python" {
  if (lang === "typescript") return "typescript";
  if (lang === "python") return "python";
  throw new Error(`score: unsupported lang for silent-handler detection: ${lang}`);
}

export function checkLang(lang: Lang): "typescript" | "python" {
  if (lang === "typescript") return "typescript";
  if (lang === "python") return "python";
  throw new Error(`score: unsupported lang for behaviorCheck running: ${lang}`);
}

function referenceLang(lang: Lang): "typescript" | "python" {
  if (lang === "typescript") return "typescript";
  if (lang === "python") return "python";
  throw new Error(`score: unsupported lang for reference scanning: ${lang}`);
}

async function extractFunctions(lang: Lang, path: string, after: string): Promise<Extracted> {
  if (lang === "typescript") return await typescriptExtractor.extract({ path, after });
  if (lang === "python") return await pythonExtractor.extract({ path, after });
  throw new Error(`score: unsupported lang for extraction: ${lang}`);
}

const BROKEN_METRICS: Metrics = { decisionPoints: 0, nFunctions: 0, silentHandlers: 0, parsed: false };

async function computeMetrics(lang: Lang, path: string, source: string | undefined): Promise<Metrics> {
  if (source === undefined) return BROKEN_METRICS;

  const extracted = await extractFunctions(lang, path, source);
  return {
    decisionPoints: decisionPoints(extracted.functions),
    nFunctions: extracted.functions.length,
    silentHandlers: countSilentHandlers(source, silentHandlerLang(lang)),
    parsed: true,
  };
}

function addMetrics(a: Metrics, b: Metrics): Metrics {
  return {
    decisionPoints: a.decisionPoints + b.decisionPoints,
    nFunctions: a.nFunctions + b.nFunctions,
    silentHandlers: a.silentHandlers + b.silentHandlers,
    parsed: a.parsed && b.parsed,
  };
}

async function aggregateAfterMetrics(lang: Lang, paths: string[], files: Record<string, string>): Promise<Metrics> {
  let total: Metrics = { decisionPoints: 0, nFunctions: 0, silentHandlers: 0, parsed: true };

  for (const path of paths) {
    const source = files[path];
    if (source === undefined) return BROKEN_METRICS;
    if (!sourceParses(source, referenceLang(lang))) return { ...total, parsed: false };
    total = addMetrics(total, await computeMetrics(lang, path, source));
  }

  return total;
}

export function entryChangedFor(before: string, after: string | undefined): boolean {
  return after === undefined ? true : after !== before;
}

function findCase(cases: CaseManifest[], caseId: string): CaseManifest {
  const kase = cases.find((c) => c.id === caseId);
  if (kase === undefined) throw new Error(`score: unknown case id in raw row: ${caseId}`);
  return kase;
}

function readBeforeSource(corpusDir: string, kase: CaseManifest): string {
  return readFileSync(join(corpusDir, kase.id, `${kase.entry}.case`), "utf8");
}

export function createdFilesOf(kase: CaseManifest, files: Record<string, string>): string[] {
  const declared = new Set(declaredFiles(kase));
  return Object.keys(files)
    .filter((path) => !declared.has(path))
    .sort();
}

export async function metricsOf(kase: CaseManifest, files: Record<string, string>): Promise<Metrics> {
  const createdFiles = createdFilesOf(kase, files);
  const scan = scanReferences({ lang: referenceLang(kase.lang), entry: kase.entry, files, created: createdFiles });
  return aggregateAfterMetrics(kase.lang, [kase.entry, ...scan.referenced], files);
}

function pristineSourceFiles(corpusDir: string, kase: CaseManifest): Record<string, string> {
  const stripped = declaredFiles(kase);
  const files: Record<string, string> = {};
  kase.files.forEach((file, i) => {
    files[stripped[i]!] = readFileSync(join(corpusDir, kase.id, file), "utf8");
  });
  return files;
}

export async function entrySymbolComplexityOf(kase: CaseManifest, source: string | undefined): Promise<number | null> {
  if (source === undefined) return null;
  const extracted = await extractFunctions(kase.lang, kase.entry, source);
  const fn = extracted.functions.find((f) => f.name === kase.entrySymbol);
  return fn?.cyclomaticComplexity ?? null;
}

function droppedHitFor(candidate: string, dropped: string[]): string | undefined {
  return dropped.find((d) => d === candidate || (d.endsWith("/") && candidate.startsWith(d)));
}

function assertNoDroppedReferences(row: RawRow, unresolved: string[]): void {
  const dropped = row.snapshotDropped ?? [];
  for (const candidate of unresolved) {
    const hit = droppedHitFor(candidate, dropped);
    if (hit === undefined) continue;
    throw new Error(
      `score: ${row.treatmentId}/${row.caseId}#${row.repetition} references ${candidate} which the snapshot dropped (${hit}); row cannot be judged`,
    );
  }
}

function buildJudgeResult(
  before: Metrics,
  after: Metrics,
  entryChanged: boolean,
  checkOutcome: BehaviorCheckOutcome | undefined,
  createdFiles: string[],
  referencedFiles: string[],
  genuineDpMax: number | undefined,
): JudgeResult {
  const checksPassed = checkOutcome?.passed;
  const { verdict, gamedReason } = classifyVerdict({
    before,
    after,
    entryChanged,
    ...(checksPassed !== undefined ? { checksPassed } : {}),
    ...(genuineDpMax !== undefined ? { genuineDpMax } : {}),
  });
  return {
    verdict,
    before,
    after,
    createdFiles,
    referencedFiles,
    ...(gamedReason !== undefined ? { gamedReason } : {}),
    ...(checksPassed !== undefined ? { checksPassed } : {}),
    ...(checkOutcome !== undefined ? { failedBehaviorChecks: checkOutcome.failures } : {}),
  };
}

function erroredJudgeResult(): JudgeResult {
  return { verdict: "errored", before: BROKEN_METRICS, after: BROKEN_METRICS, createdFiles: [], referencedFiles: [] };
}

function timedOutJudgeResult(): JudgeResult {
  return { verdict: "timed-out", before: BROKEN_METRICS, after: BROKEN_METRICS, createdFiles: [], referencedFiles: [] };
}

function shouldRunBehaviorChecks(entryChanged: boolean, after: Metrics, afterSource: string | undefined): afterSource is string {
  return entryChanged && after.parsed && afterSource !== undefined;
}

function runCaseBehaviorChecks(kase: CaseManifest, afterSource: string, files: Record<string, string>): BehaviorCheckOutcome {
  return runBehaviorChecks({
    lang: checkLang(kase.lang),
    entryFilename: kase.entry,
    source: afterSource,
    entrySymbol: kase.entrySymbol,
    behaviorChecks: kase.behaviorChecks,
    files,
  });
}

export interface ContaminationCheck {
  runDir: string;
  answerKeyPrefixes: string[];
  railPrefixes: string[];
}

function transcriptRelativePath(row: RawRow): string {
  return join("transcripts", `${row.caseId}.${row.treatmentId}.${row.repetition}.jsonl`);
}

function transcriptPathFor(runDir: string, row: RawRow): string {
  return join(runDir, transcriptRelativePath(row));
}

export function readTranscriptIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

interface RowContamination {
  contaminated: boolean;
  consultedRail: boolean;
}

const ROW_NOT_CONTAMINATED: RowContamination = { contaminated: false, consultedRail: false };

function classifyRow(row: RawRow, contamination: ContaminationCheck | undefined): RowContamination {
  if (contamination === undefined) return ROW_NOT_CONTAMINATED;

  const transcript = readTranscriptIfPresent(transcriptPathFor(contamination.runDir, row));
  if (transcript === undefined) return ROW_NOT_CONTAMINATED;

  return classifyTranscript(transcript, { answerKeyPrefixes: contamination.answerKeyPrefixes, railPrefixes: contamination.railPrefixes });
}

interface RecordFacts {
  entryChanged: boolean;
  entrySymbolComplexityBefore: number | null;
  entrySymbolComplexityAfter: number | null;
  linesAdded: number;
  linesRemoved: number;
}

async function computeRecordFacts(row: RawRow, corpusDir: string, kase: CaseManifest, beforeSource: string, afterSource: string | undefined): Promise<RecordFacts> {
  const entryChanged = entryChangedFor(beforeSource, afterSource);
  const entrySymbolComplexityBefore = await entrySymbolComplexityOf(kase, beforeSource);
  const entrySymbolComplexityAfter = await entrySymbolComplexityOf(kase, afterSource);
  const { linesAdded, linesRemoved } = sourceDiffCounts(pristineSourceFiles(corpusDir, kase), row.files, kase.lang);
  return { entryChanged, entrySymbolComplexityBefore, entrySymbolComplexityAfter, linesAdded, linesRemoved };
}

async function judgeRow(row: RawRow, cases: CaseManifest[], corpusDir: string, contamination: ContaminationCheck | undefined): Promise<JudgedRow> {
  const { contaminated, consultedRail } = classifyRow(row, contamination);
  const kase = findCase(cases, row.caseId);
  const beforeSource = readBeforeSource(corpusDir, kase);
  const afterSource = row.files[kase.entry];
  const recordFacts = await computeRecordFacts(row, corpusDir, kase, beforeSource, afterSource);

  if (row.timedOut === true) return { row, judge: timedOutJudgeResult(), contaminated, consultedRail, ...recordFacts };
  if (row.agentError !== undefined) return { row, judge: erroredJudgeResult(), contaminated, consultedRail, ...recordFacts };

  const before = await computeMetrics(kase.lang, kase.entry, beforeSource);

  const createdFiles = createdFilesOf(kase, row.files);
  const scan = scanReferences({ lang: referenceLang(kase.lang), entry: kase.entry, files: row.files, created: createdFiles });
  assertNoDroppedReferences(row, scan.unresolved);
  const after = await aggregateAfterMetrics(kase.lang, [kase.entry, ...scan.referenced], row.files);

  const checkOutcome = shouldRunBehaviorChecks(recordFacts.entryChanged, after, afterSource) ? runCaseBehaviorChecks(kase, afterSource, row.files) : undefined;

  const judge = buildJudgeResult(before, after, recordFacts.entryChanged, checkOutcome, createdFiles, scan.referenced, kase.genuineDpMax);
  return { row, judge, contaminated, consultedRail, ...recordFacts };
}

export async function judgeRows(rows: RawRow[], corpusDir: string, contamination?: ContaminationCheck): Promise<JudgedRow[]> {
  const cases = loadCases(corpusDir);
  if ("error" in cases) throw new Error(`score: failed to load corpus: ${cases.error}`);

  const judged: JudgedRow[] = [];
  for (const row of rows) {
    judged.push(await judgeRow(row, cases, corpusDir, contamination));
  }
  return judged;
}

function emptyCounts(): Record<Verdict, number> {
  return Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
}

function emptyGamedReasons(): Record<GamedReason, number> {
  return Object.fromEntries(GAMED_REASONS.map((r) => [r, 0])) as Record<GamedReason, number>;
}

function newSummaryRow(treatmentId: string, caseId: string | null, tier: Tier | null, env: JudgeEnv): SummaryRow {
  return {
    treatmentId,
    caseId,
    tier,
    counts: emptyCounts(),
    gamedReasons: emptyGamedReasons(),
    total: 0,
    withCreatedFiles: 0,
    contaminated: 0,
    railConsults: 0,
    meanDpReduction: null,
    meanDurationMs: null,
    meanTurns: null,
    meanTokensIn: null,
    meanTokensOut: null,
    meanNudges: null,
    costAvailable: 0,
    judgedAtSha: env.judgedAtSha,
    pyCcBackend: env.pyCcBackend,
  };
}

function addJudgeToRow(bucket: SummaryRow, judge: JudgeResult, contaminated: boolean, consultedRail: boolean): void {
  bucket.counts[judge.verdict] += 1;
  bucket.total += 1;
  if (judge.gamedReason !== undefined) bucket.gamedReasons[judge.gamedReason] += 1;
  if (judge.createdFiles.length > 0) bucket.withCreatedFiles += 1;
  if (contaminated) bucket.contaminated += 1;
  if (consultedRail) bucket.railConsults += 1;
}

function detailKey(treatmentId: string, caseId: string): string {
  return `${treatmentId}\0${caseId}`;
}

interface DpReductionAccumulator {
  sum: number;
  count: number;
}

const DP_REDUCTION_VERDICTS: readonly Verdict[] = ["genuine-fix", "bar-missed"];

function newDpReductionAccumulator(): DpReductionAccumulator {
  return { sum: 0, count: 0 };
}

function addDpReduction(acc: DpReductionAccumulator, judge: JudgeResult): void {
  if (!DP_REDUCTION_VERDICTS.includes(judge.verdict)) return;
  acc.sum += judge.before.decisionPoints - judge.after.decisionPoints;
  acc.count += 1;
}

function meanDpReductionOf(acc: DpReductionAccumulator): number | null {
  return acc.count === 0 ? null : acc.sum / acc.count;
}

const RULE_NAMES: readonly RuleName[] = Object.values(RULE);

function zeroNudges(): Record<RuleName, number> {
  return Object.fromEntries(RULE_NAMES.map((rule) => [rule, 0])) as Record<RuleName, number>;
}

interface CostAccumulator {
  durationSum: number;
  turnsSum: number;
  tokensInSum: number;
  tokensOutSum: number;
  nudgesSum: Record<RuleName, number>;
  available: number;
}

function newCostAccumulator(): CostAccumulator {
  return { durationSum: 0, turnsSum: 0, tokensInSum: 0, tokensOutSum: 0, nudgesSum: zeroNudges(), available: 0 };
}

function costFieldsPresent(row: RawRow): row is RawRow & { turns: number; tokensIn: number; tokensOut: number; nudges: Record<RuleName, number> } {
  return row.turns !== undefined && row.tokensIn !== undefined && row.tokensOut !== undefined && row.nudges !== undefined;
}

function addCostMetrics(acc: CostAccumulator, row: RawRow): void {
  acc.durationSum += row.durationMs;
  if (!costFieldsPresent(row)) return;

  acc.available += 1;
  acc.turnsSum += row.turns;
  acc.tokensInSum += row.tokensIn;
  acc.tokensOutSum += row.tokensOut;
  for (const rule of RULE_NAMES) acc.nudgesSum[rule] += row.nudges[rule];
}

function meanOf(sum: number, count: number): number | null {
  return count === 0 ? null : sum / count;
}

interface CostSummary {
  meanDurationMs: number | null;
  meanTurns: number | null;
  meanTokensIn: number | null;
  meanTokensOut: number | null;
  meanNudges: Record<RuleName, number> | null;
  costAvailable: number;
}

function finalizeCost(acc: CostAccumulator, totalRows: number): CostSummary {
  const meanNudges =
    acc.available === 0 ? null : (Object.fromEntries(RULE_NAMES.map((rule) => [rule, acc.nudgesSum[rule] / acc.available])) as Record<RuleName, number>);

  return {
    meanDurationMs: meanOf(acc.durationSum, totalRows),
    meanTurns: meanOf(acc.turnsSum, acc.available),
    meanTokensIn: meanOf(acc.tokensInSum, acc.available),
    meanTokensOut: meanOf(acc.tokensOutSum, acc.available),
    meanNudges,
    costAvailable: acc.available,
  };
}

interface SummaryBucket {
  row: SummaryRow;
  dpReduction: DpReductionAccumulator;
  cost: CostAccumulator;
}

function newSummaryBucket(treatmentId: string, caseId: string | null, tier: Tier | null, env: JudgeEnv): SummaryBucket {
  return { row: newSummaryRow(treatmentId, caseId, tier, env), dpReduction: newDpReductionAccumulator(), cost: newCostAccumulator() };
}

function addJudgeToBucket(bucket: SummaryBucket, row: RawRow, judge: JudgeResult, contaminated: boolean, consultedRail: boolean): void {
  addJudgeToRow(bucket.row, judge, contaminated, consultedRail);
  addDpReduction(bucket.dpReduction, judge);
  addCostMetrics(bucket.cost, row);
}

function finalizeSummaryRow(bucket: SummaryBucket): SummaryRow {
  return { ...bucket.row, meanDpReduction: meanDpReductionOf(bucket.dpReduction), ...finalizeCost(bucket.cost, bucket.row.total) };
}

interface AggregationBuckets {
  overall: Map<string, SummaryBucket>;
  tier: Map<string, SummaryBucket>;
  detail: Map<string, SummaryBucket>;
}

function newAggregationBuckets(): AggregationBuckets {
  return { overall: new Map(), tier: new Map(), detail: new Map() };
}

function upsertBucket(
  buckets: Map<string, SummaryBucket>,
  key: string,
  treatmentId: string,
  caseId: string | null,
  tier: Tier | null,
  env: JudgeEnv,
  row: RawRow,
  judge: JudgeResult,
  contaminated: boolean,
  consultedRail: boolean,
): void {
  const bucket = buckets.get(key) ?? newSummaryBucket(treatmentId, caseId, tier, env);
  addJudgeToBucket(bucket, row, judge, contaminated, consultedRail);
  buckets.set(key, bucket);
}

function accumulateRow(buckets: AggregationBuckets, judgedRow: JudgedRow, tier: Tier | null, env: JudgeEnv): void {
  const { row, judge, contaminated, consultedRail } = judgedRow;
  upsertBucket(buckets.overall, row.treatmentId, row.treatmentId, null, null, env, row, judge, contaminated, consultedRail);
  if (tier !== null) {
    upsertBucket(buckets.tier, detailKey(row.treatmentId, tier), row.treatmentId, null, tier, env, row, judge, contaminated, consultedRail);
  }
  upsertBucket(buckets.detail, detailKey(row.treatmentId, row.caseId), row.treatmentId, row.caseId, tier, env, row, judge, contaminated, consultedRail);
}

export function aggregate(judged: JudgedRow[], env: JudgeEnv, tierByCaseId: Map<string, Tier> = new Map()): SummaryRow[] {
  const buckets = newAggregationBuckets();

  for (const judgedRow of judged) {
    const tier = tierByCaseId.get(judgedRow.row.caseId) ?? null;
    accumulateRow(buckets, judgedRow, tier, env);
  }

  return [...buckets.overall.values(), ...buckets.tier.values(), ...buckets.detail.values()].map(finalizeSummaryRow);
}

function genuineRate(row: SummaryRow): number {
  return row.total === 0 ? 0 : (row.counts["genuine-fix"] / row.total) * 100;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatMeanDpReduction(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function formatMeanMs(value: number | null): string {
  return value === null ? "-" : Math.round(value).toString();
}

function formatMean(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function formatNudgesPerRepetition(value: Record<RuleName, number> | null): string {
  if (value === null) return "-";
  const total = Object.values(value).reduce((sum, count) => sum + count, 0);
  return total.toFixed(1);
}

function treatmentCell(row: SummaryRow): string {
  return row.tier === null ? row.treatmentId : `${row.treatmentId} [${row.tier}]`;
}

function markdownRow(row: SummaryRow): string {
  const c = row.counts;
  return `| ${treatmentCell(row)} | ${row.total} | ${c["genuine-fix"]} | ${c.gamed} | ${c["bar-missed"]} | ${c.untouched} | ${c.broken} | ${c["behavior-broken"]} | ${c.errored} | ${c["timed-out"]} | ${row.withCreatedFiles} | ${row.contaminated} | ${row.railConsults} | ${formatPercent(genuineRate(row))} | ${formatMeanDpReduction(row.meanDpReduction)} | ${formatMeanMs(row.meanDurationMs)} | ${formatMean(row.meanTurns)} | ${formatMean(row.meanTokensIn)} | ${formatMean(row.meanTokensOut)} | ${formatNudgesPerRepetition(row.meanNudges)} |`;
}

export function formatMarkdown(summary: SummaryRow[]): string {
  const rollups = summary.filter((r) => r.caseId === null);
  const header =
    "| treatment | n | genuine-fix | gamed | bar-missed | untouched | broken | behavior-broken | errored | timed-out | created-files | contaminated | rail-consults | genuine % | mean dp cut | mean ms | mean turns | tokens in | tokens out | nudges/repetition |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  return [header, divider, ...rollups.map(markdownRow)].join("\n");
}

type ProvenanceField = { label: string; value: (p: Provenance) => string };

const PROVENANCE_FIELDS: readonly ProvenanceField[] = [
  { label: "model", value: (p) => p.model },
  { label: "phrasing pack", value: (p) => (p.phrasingPackHash === null ? "none" : p.phrasingPackHash.slice(0, 8)) },
  { label: "liubai sha", value: (p) => p.liubaiSha },
];

function distinctValues(items: Provenance[], value: (p: Provenance) => string): string[] {
  return [...new Set(items.map(value))].sort();
}

function arraysEqual(x: string[], y: string[]): boolean {
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function compareProvenance(a: Provenance[], b: Provenance[]): string[] {
  const lines: string[] = [];
  for (const field of PROVENANCE_FIELDS) {
    const aValues = distinctValues(a, field.value);
    const bValues = distinctValues(b, field.value);
    if (arraysEqual(aValues, bValues)) continue;
    lines.push(`${field.label} differs: ${aValues.join(", ")} vs ${bValues.join(", ")}`);
  }
  return lines;
}

export type ParsedRaw = { rows: RawRow[] } | { error: string };

function parseRawLine(line: string, lineNumber: number, runDir: string): { row: RawRow } | { error: string } {
  try {
    return { row: JSON.parse(line) as RawRow };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: `score: malformed raw.jsonl line ${lineNumber} in ${runDir}: ${reason}` };
  }
}

export function readRawJsonl(runDir: string): ParsedRaw {
  const text = readFileSync(join(runDir, RAW_FILENAME), "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  const rows: RawRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseRawLine(lines[i]!, i + 1, runDir);
    if ("error" in parsed) return parsed;
    rows.push(parsed.row);
  }
  return { rows };
}

function writeSummaryJsonl(runDir: string, summary: SummaryRow[]): void {
  const content = summary.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(runDir, SUMMARY_FILENAME), content);
}

export function recordFor(runDir: string, judgedRow: JudgedRow, startsFrom: StartsFrom): RepetitionRecord {
  const { row, judge, contaminated, consultedRail } = judgedRow;
  const relativePath = transcriptRelativePath(row);
  const sessionLog = readTranscriptIfPresent(join(runDir, relativePath));

  return buildRepetitionRecord({
    row,
    startsFrom,
    transcriptPath: sessionLog === undefined ? null : relativePath,
    sessionLog,
    verdict: judge.verdict,
    gamedReason: judge.gamedReason ?? null,
    failedBehaviorChecks: judge.failedBehaviorChecks ?? [],
    decisionPointsBefore: judge.before.decisionPoints,
    decisionPointsAfter: judge.after.decisionPoints,
    entrySymbolComplexityBefore: judgedRow.entrySymbolComplexityBefore,
    entrySymbolComplexityAfter: judgedRow.entrySymbolComplexityAfter,
    functionsBefore: judge.before.nFunctions,
    functionsAfter: judge.after.nFunctions,
    linesAdded: judgedRow.linesAdded,
    linesRemoved: judgedRow.linesRemoved,
    entryUnchanged: !judgedRow.entryChanged,
    filesCreated: judge.createdFiles,
    contaminated,
    consultedRail,
  });
}

function buildRecords(runDir: string, judged: JudgedRow[]): RepetitionRecord[] {
  return judged.map((judgedRow) => recordFor(runDir, judgedRow, { kind: "original-source" }));
}

const MISSING_SESSION_LOG_PREVIEW_COUNT = 5;

export function missingSessionLogWarning(records: RepetitionRecord[]): string | undefined {
  const missing = records.filter((record) => record.transcriptPath === null);
  if (missing.length === 0) return undefined;

  const preview = missing.slice(0, MISSING_SESSION_LOG_PREVIEW_COUNT).map((r) => `${r.treatmentId}/${r.caseId}#${r.repetition}`);
  const remaining = missing.length - preview.length;
  const suffix = remaining > 0 ? `, and ${remaining} more` : "";
  return `score: ${missing.length} session(s) have no session log: ${preview.join(", ")}${suffix}`;
}

export function writeJudgedJsonl(runDir: string, records: RepetitionRecord[]): void {
  const content = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  writeFileSync(join(runDir, JUDGED_FILENAME), content);
}

export function withWarningSuffix(stdout: string, warning: string | undefined): string {
  return warning === undefined ? stdout : `${stdout}\n${warning}`;
}

function anyRowNeedsPython(rows: RawRow[], cases: CaseManifest[]): boolean {
  const langById = new Map(cases.map((c) => [c.id, c.lang]));
  return rows.some((row) => langById.get(row.caseId) === "python");
}

function resolveJudgeEnv(rows: RawRow[], corpusDir: string, repoRoot: string, pythonBin?: string): { env: JudgeEnv } | { error: string } {
  const cases = loadCases(corpusDir);
  if ("error" in cases) return { error: `score: failed to load corpus: ${cases.error}` };

  const judgedAtSha = gitSha(repoRoot);
  if (!anyRowNeedsPython(rows, cases)) return { env: { judgedAtSha, pyCcBackend: "none" } };

  try {
    return { env: { judgedAtSha, pyCcBackend: probePyCcBackend(pythonBin) } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function allRowsErrored(rows: RawRow[]): boolean {
  return rows.length > 0 && rows.every((row) => row.agentError !== undefined);
}

function firstAgentError(rows: RawRow[]): string {
  const errored = rows.find((row) => row.agentError !== undefined);
  return errored?.agentError ?? FALLBACK_AGENT_ERROR;
}

function genuineRateDeltaLine(current: SummaryRow, compare: SummaryRow): string {
  const currentRate = formatPercent(genuineRate(current));
  const compareRate = formatPercent(genuineRate(compare));
  return `${current.treatmentId}: genuine ${compareRate} -> ${currentRate}`;
}

function isOverallRollup(row: SummaryRow): boolean {
  return row.caseId === null && row.tier === null;
}

function genuineRateDeltaSection(currentSummary: SummaryRow[], compareSummary: SummaryRow[]): string[] {
  const compareByTreatment = new Map(compareSummary.filter(isOverallRollup).map((r) => [r.treatmentId, r]));

  const lines: string[] = [];
  for (const current of currentSummary) {
    if (!isOverallRollup(current)) continue;
    const compare = compareByTreatment.get(current.treatmentId);
    if (compare === undefined) continue;
    lines.push(genuineRateDeltaLine(current, compare));
  }
  return lines;
}

async function buildCompareSection(
  currentRows: RawRow[],
  currentSummary: SummaryRow[],
  compareRunDir: string,
  corpusDir: string,
  env: JudgeEnv,
  tierByCaseId: Map<string, Tier>,
): Promise<{ text: string } | { error: string }> {
  const compareParsed = readRawJsonl(compareRunDir);
  if ("error" in compareParsed) return compareParsed;

  const provenanceDiff = compareProvenance(
    currentRows.map((r) => r.provenance),
    compareParsed.rows.map((r) => r.provenance),
  );
  const provenanceLines = provenanceDiff.length > 0 ? provenanceDiff : ["provenance identical"];

  const compareJudged = await judgeRows(compareParsed.rows, corpusDir);
  const compareSummary = aggregate(compareJudged, env, tierByCaseId);
  const deltaLines = genuineRateDeltaSection(currentSummary, compareSummary);

  return { text: [...provenanceLines, "", ...deltaLines, ""].join("\n") };
}

function tierByCaseId(cases: CaseManifest[]): Map<string, Tier> {
  return new Map(cases.map((c) => [c.id, c.tier]));
}

function loadTierByCaseId(corpusDir: string): { map: Map<string, Tier> } | { error: string } {
  const cases = loadCases(corpusDir);
  if ("error" in cases) return { error: `score: failed to load corpus: ${cases.error}` };
  return { map: tierByCaseId(cases) };
}

async function judgeAndSummarize(
  rows: RawRow[],
  corpusDir: string,
  env: JudgeEnv,
  contamination: ContaminationCheck,
): Promise<{ judged: JudgedRow[]; summary: SummaryRow[]; tierByCaseId: Map<string, Tier> } | { error: string }> {
  let judged: JudgedRow[];
  try {
    judged = await judgeRows(rows, corpusDir, contamination);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const tierMap = loadTierByCaseId(corpusDir);
  if ("error" in tierMap) return tierMap;

  return { judged, summary: aggregate(judged, env, tierMap.map), tierByCaseId: tierMap.map };
}

export type DeliveryViolationKind = "not-delivered" | "missing-stamp" | "live-rules-silent" | "shadow-rules-silent" | "prompt-not-carried";

export interface DeliveryViolation {
  kind: DeliveryViolationKind;
  treatmentId: string;
  caseId?: string;
  repetition?: number;
  message: string;
}

export interface TreatmentDeliverySummary {
  treatmentId: string;
  repetitions: number;
  liveNudges: number;
  shadowNudges: number;
  promptCarried: boolean;
}

export type DeliveryValidity =
  | { kind: "unstamped"; warning: string }
  | { kind: "invalid"; violations: DeliveryViolation[] }
  | { kind: "valid"; treatments: TreatmentDeliverySummary[] };

const UNSTAMPED_DELIVERY_WARNING =
  "score: no row in this run carries a delivery stamp; delivery validity is unverifiable (the run predates stamping) — scoring proceeds without delivery checks";

function rowLabel(row: RawRow): string {
  return `${row.treatmentId}/${row.caseId}#${row.repetition}`;
}

function notDeliveredViolations(rows: RawRow[]): DeliveryViolation[] {
  return rows
    .filter((row) => row.delivered !== undefined && row.delivered.packHash !== row.provenance.phrasingPackHash)
    .map((row) => ({
      kind: "not-delivered",
      treatmentId: row.treatmentId,
      caseId: row.caseId,
      repetition: row.repetition,
      message: `${rowLabel(row)}: treatment not delivered — claimed pack ${row.provenance.phrasingPackHash ?? "none"}, delivered ${row.delivered!.packHash ?? "none"}`,
    }));
}

function isPromptCarried(treatmentById: Map<string, TreatmentManifest>, treatmentId: string): boolean {
  return treatmentById.get(treatmentId)?.delivery === "prompt";
}

function missingStampViolations(rows: RawRow[], treatmentById: Map<string, TreatmentManifest>): DeliveryViolation[] {
  return rows
    .filter((row) => row.delivered === undefined && !isPromptCarried(treatmentById, row.treatmentId))
    .map((row) => ({
      kind: "missing-stamp",
      treatmentId: row.treatmentId,
      caseId: row.caseId,
      repetition: row.repetition,
      message: `${rowLabel(row)}: no delivery stamp while other rows in this run carry one — rails likely never loaded for this repetition`,
    }));
}

function packContentFor(treatmentsDir: string, treatment: TreatmentManifest): string | undefined {
  if (treatment.phrasingPack === undefined) return undefined;
  return readFileSync(join(treatmentsDir, treatment.phrasingPack), "utf8");
}

function expectedPromptMessage(treatmentsDir: string, treatment: TreatmentManifest, kase: CaseManifest): string {
  const packContent = packContentFor(treatmentsDir, treatment);
  if (packContent === undefined) {
    throw new Error(`treatment ${treatment.id}: delivery "prompt" carries no phrasing pack — treatments.ts validation should have rejected this at load time`);
  }
  return promptCarriedTreatmentMessage(kase, packContent);
}

function promptNotCarriedViolation(row: RawRow, message: string): DeliveryViolation {
  return { kind: "prompt-not-carried", treatmentId: row.treatmentId, caseId: row.caseId, repetition: row.repetition, message };
}

function promptCarriedViolations(
  rows: RawRow[],
  treatmentById: Map<string, TreatmentManifest>,
  treatmentsDir: string,
  caseById: Map<string, CaseManifest>,
): DeliveryViolation[] {
  const violations: DeliveryViolation[] = [];

  for (const row of rows) {
    const treatment = treatmentById.get(row.treatmentId);
    if (treatment?.delivery !== "prompt") continue;

    const kase = caseById.get(row.caseId);
    if (kase === undefined) {
      violations.push(promptNotCarriedViolation(row, `${rowLabel(row)}: opening prompt cannot be verified — case ${row.caseId} has no manifest in the corpus`));
      continue;
    }

    const expected = expectedPromptMessage(treatmentsDir, treatment, kase);
    if (row.task !== undefined && row.task.includes(expected)) continue;

    violations.push(
      promptNotCarriedViolation(row, `${rowLabel(row)}: opening prompt does not carry the treatment's message — delivery: "prompt" requires the treatment's phrasing inside the sent task`),
    );
  }

  return violations;
}

function rowsByTreatment(rows: RawRow[]): Map<string, RawRow[]> {
  const groups = new Map<string, RawRow[]>();
  for (const row of rows) {
    const treatmentRows = groups.get(row.treatmentId);
    if (treatmentRows === undefined) groups.set(row.treatmentId, [row]);
    else treatmentRows.push(row);
  }
  return groups;
}

function unionDeliveredRules(rows: RawRow[], pick: (delivered: NonNullable<RawRow["delivered"]>) => string[]): string[] {
  const rules = new Set<string>();
  for (const row of rows) {
    if (row.delivered === undefined) continue;
    for (const rule of pick(row.delivered)) rules.add(rule);
  }
  return [...rules];
}

function sumNudges(rows: RawRow[], pick: (row: RawRow) => Record<RuleName, number> | undefined): number {
  let total = 0;
  for (const row of rows) {
    const nudges = pick(row);
    if (nudges === undefined) continue;
    for (const count of Object.values(nudges)) total += count;
  }
  return total;
}

function nudgeFloorViolation(
  kind: Extract<DeliveryViolationKind, "live-rules-silent" | "shadow-rules-silent">,
  treatmentId: string,
  rules: string[],
  repetitions: number,
): DeliveryViolation {
  const label = kind === "live-rules-silent" ? "live" : "shadow";
  return { kind, treatmentId, message: `${treatmentId}: ${label} rules ${rules.join(", ")} were delivered but never fired across ${repetitions} rows` };
}

function nudgeFloorViolations(treatmentId: string, treatmentRows: RawRow[], manifest: TreatmentManifest | undefined): DeliveryViolation[] {
  if (manifest?.expectedZeroNudges === true) return [];
  if (manifest?.delivery === "prompt") return [];

  const violations: DeliveryViolation[] = [];

  const liveRules = unionDeliveredRules(treatmentRows, (d) => d.liveRules);
  if (liveRules.length > 0 && sumNudges(treatmentRows, (row) => row.nudges) === 0) {
    violations.push(nudgeFloorViolation("live-rules-silent", treatmentId, liveRules, treatmentRows.length));
  }

  const shadowRules = unionDeliveredRules(treatmentRows, (d) => d.shadowRules);
  if (shadowRules.length > 0 && sumNudges(treatmentRows, (row) => row.shadowNudges) === 0) {
    violations.push(nudgeFloorViolation("shadow-rules-silent", treatmentId, shadowRules, treatmentRows.length));
  }

  return violations;
}

function treatmentSummaryFor(treatmentId: string, treatmentRows: RawRow[], manifest: TreatmentManifest | undefined): TreatmentDeliverySummary {
  return {
    treatmentId,
    repetitions: treatmentRows.length,
    liveNudges: sumNudges(treatmentRows, (row) => row.nudges),
    shadowNudges: sumNudges(treatmentRows, (row) => row.shadowNudges),
    promptCarried: manifest?.delivery === "prompt",
  };
}

function checkDeliveryValidity(
  rows: RawRow[],
  treatments: TreatmentManifest[],
  treatmentsDir: string,
  caseById: Map<string, CaseManifest>,
): DeliveryValidity {
  const treatmentById = new Map(treatments.map((c) => [c.id, c]));
  const treatmentRowGroups = [...rowsByTreatment(rows)];

  const violations = [
    ...notDeliveredViolations(rows),
    ...missingStampViolations(rows, treatmentById),
    ...promptCarriedViolations(rows, treatmentById, treatmentsDir, caseById),
    ...treatmentRowGroups.flatMap(([treatmentId, treatmentRows]) => nudgeFloorViolations(treatmentId, treatmentRows, treatmentById.get(treatmentId))),
  ];
  if (violations.length > 0) return { kind: "invalid", violations };

  const treatmentSummaries = treatmentRowGroups
    .map(([treatmentId, treatmentRows]) => treatmentSummaryFor(treatmentId, treatmentRows, treatmentById.get(treatmentId)))
    .sort((a, b) => a.treatmentId.localeCompare(b.treatmentId));
  return { kind: "valid", treatments: treatmentSummaries };
}

function resolveDeliveryValidity(rows: RawRow[], treatmentsDir: string, corpusDir: string): { result: DeliveryValidity } | { error: string } {
  const treatments = loadTreatments(treatmentsDir);
  if ("error" in treatments) return { error: `score: failed to load treatments: ${treatments.error}` };

  const treatmentById = new Map(treatments.map((c) => [c.id, c]));
  const isLegacyRailOnlyRun = rows.every((row) => !isPromptCarried(treatmentById, row.treatmentId) && row.delivered === undefined);
  if (rows.length > 0 && isLegacyRailOnlyRun) {
    return { result: { kind: "unstamped", warning: UNSTAMPED_DELIVERY_WARNING } };
  }

  const cases = loadCases(corpusDir);
  if ("error" in cases) return { error: `score: failed to load corpus: ${cases.error}` };
  const caseById = new Map(cases.map((c) => [c.id, c]));

  return { result: checkDeliveryValidity(rows, treatments, treatmentsDir, caseById) };
}

function formatDeliveryViolations(violations: DeliveryViolation[]): string {
  return violations.map((v) => `score: delivery violation [${v.kind}] ${v.message}`).join("\n");
}

function formatDeliveryValidityBlock(treatments: TreatmentDeliverySummary[]): string {
  const lines = treatments.map(
    (a) => `  ${a.treatmentId}: repetitions=${a.repetitions} liveNudges=${a.liveNudges} shadowNudges=${a.shadowNudges} delivered=${a.promptCarried ? "prompt" : "ok"}`,
  );
  return [...lines, ""].join("\n");
}

function deliveryStdoutPrefix(validity: Exclude<DeliveryValidity, { kind: "invalid" }>): string {
  if (validity.kind === "unstamped") return `${validity.warning}\n\n`;
  return `delivery validity:\n${formatDeliveryValidityBlock(validity.treatments)}\n`;
}

export async function runScore(opts: {
  runDir: string;
  corpusDir: string;
  repoRoot: string;
  treatmentsDir?: string;
  compareRunDir?: string;
  pythonBin?: string;
}): Promise<{ status: number; stdout: string }> {
  const parsedRaw = readRawJsonl(opts.runDir);
  if ("error" in parsedRaw) return { status: ERROR_STATUS, stdout: parsedRaw.error };

  const validity = resolveDeliveryValidity(parsedRaw.rows, opts.treatmentsDir ?? DEFAULT_TREATMENTS_DIR, opts.corpusDir);
  if ("error" in validity) return { status: ERROR_STATUS, stdout: validity.error };
  if (validity.result.kind === "invalid") return { status: ERROR_STATUS, stdout: formatDeliveryViolations(validity.result.violations) };

  if (allRowsErrored(parsedRaw.rows)) {
    return { status: ERROR_STATUS, stdout: `score: every row in this run agent-errored; first: ${firstAgentError(parsedRaw.rows)}` };
  }

  const judgeEnv = resolveJudgeEnv(parsedRaw.rows, opts.corpusDir, opts.repoRoot, opts.pythonBin);
  if ("error" in judgeEnv) return { status: ERROR_STATUS, stdout: judgeEnv.error };

  const contamination: ContaminationCheck = { runDir: opts.runDir, answerKeyPrefixes: ANSWER_KEY_PREFIXES, railPrefixes: RAIL_PATH_PREFIXES };
  const judgeResult = await judgeAndSummarize(parsedRaw.rows, opts.corpusDir, judgeEnv.env, contamination);
  if ("error" in judgeResult) return { status: ERROR_STATUS, stdout: judgeResult.error };

  const { judged, summary, tierByCaseId: tierMap } = judgeResult;
  writeSummaryJsonl(opts.runDir, summary);
  const records = buildRecords(opts.runDir, judged);
  writeJudgedJsonl(opts.runDir, records);
  const table = formatMarkdown(summary);
  const validityPrefix = deliveryStdoutPrefix(validity.result);
  const warning = missingSessionLogWarning(records);

  if (opts.compareRunDir === undefined) return { status: OK_STATUS, stdout: withWarningSuffix(`${validityPrefix}${table}`, warning) };

  const compareSection = await buildCompareSection(parsedRaw.rows, summary, opts.compareRunDir, opts.corpusDir, judgeEnv.env, tierMap);
  if ("error" in compareSection) return { status: ERROR_STATUS, stdout: compareSection.error };

  return { status: OK_STATUS, stdout: withWarningSuffix(`${validityPrefix}${compareSection.text}\n${table}`, warning) };
}
