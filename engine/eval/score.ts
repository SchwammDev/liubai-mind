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
import { promptCarriedArmMessage } from "./prompt-carried-message.ts";
import { runProbes } from "./probes.ts";
import { scanReferences } from "./references.ts";
import { sourceParses } from "./parse-check.ts";
import { typescriptExtractor } from "../extract-typescript.ts";
import { pythonExtractor } from "../extract-python.ts";
import { probePyCcBackend } from "./judge-env.ts";
import { gitSha } from "./provenance.ts";
import { classifyTranscript } from "./contamination.ts";

export interface JudgedRow {
  row: RawRow;
  judge: JudgeResult;
  contaminated: boolean;
  consultedRail: boolean;
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
  meanRailFirings: Record<RuleName, number> | null;
  costAvailable: number;
  judgedAtSha: string;
  pyCcBackend: string;
}

const VERDICTS: readonly Verdict[] = ["genuine-fix", "gamed", "bar-missed", "untouched", "broken", "behavior-broken", "errored", "timed-out"];
const GAMED_REASONS: readonly GamedReason[] = ["helper-split", "silent-handler"];
const SUMMARY_FILENAME = "summary.jsonl";
const JUDGED_FILENAME = "judged.jsonl";
const RAW_FILENAME = "raw.jsonl";
const ERROR_STATUS = 1;
const OK_STATUS = 0;
const FALLBACK_AGENT_ERROR = "agent error";
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const ANSWER_KEY_PREFIXES = [join(REPO_ROOT, "engine", "eval"), ".pi/agent/engine/eval"];
const RAIL_PATH_PREFIXES = [REPO_ROOT, "/.pi/", "~/.pi"];
const DEFAULT_TREATMENTS_DIR = join(import.meta.dirname, "treatments");

function silentHandlerLang(lang: Lang): "typescript" | "python" {
  if (lang === "typescript") return "typescript";
  if (lang === "python") return "python";
  throw new Error(`score: unsupported lang for silent-handler detection: ${lang}`);
}

export function probeLang(lang: Lang): "typescript" | "python" {
  if (lang === "typescript") return "typescript";
  if (lang === "python") return "python";
  throw new Error(`score: unsupported lang for probe running: ${lang}`);
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

function entryChangedFor(before: string, after: string | undefined): boolean {
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

function createdFilesOf(kase: CaseManifest, files: Record<string, string>): string[] {
  const declared = new Set(declaredFiles(kase));
  return Object.keys(files)
    .filter((path) => !declared.has(path))
    .sort();
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
  probesPassed: boolean | undefined,
  createdFiles: string[],
  referencedFiles: string[],
  genuineDpMax: number | undefined,
): JudgeResult {
  const { verdict, gamedReason } = classifyVerdict({
    before,
    after,
    entryChanged,
    ...(probesPassed !== undefined ? { probesPassed } : {}),
    ...(genuineDpMax !== undefined ? { genuineDpMax } : {}),
  });
  return {
    verdict,
    before,
    after,
    createdFiles,
    referencedFiles,
    ...(gamedReason !== undefined ? { gamedReason } : {}),
    ...(probesPassed !== undefined ? { probesPassed } : {}),
  };
}

function erroredJudgeResult(): JudgeResult {
  return { verdict: "errored", before: BROKEN_METRICS, after: BROKEN_METRICS, createdFiles: [], referencedFiles: [] };
}

function timedOutJudgeResult(): JudgeResult {
  return { verdict: "timed-out", before: BROKEN_METRICS, after: BROKEN_METRICS, createdFiles: [], referencedFiles: [] };
}

function shouldRunProbes(entryChanged: boolean, after: Metrics, afterSource: string | undefined): afterSource is string {
  return entryChanged && after.parsed && afterSource !== undefined;
}

function runCaseProbes(kase: CaseManifest, afterSource: string, files: Record<string, string>): boolean {
  const outcome = runProbes({
    lang: probeLang(kase.lang),
    entryFilename: kase.entry,
    source: afterSource,
    entrySymbol: kase.entrySymbol,
    probes: kase.probes,
    files,
  });
  return outcome.passed;
}

export interface ContaminationCheck {
  runDir: string;
  answerKeyPrefixes: string[];
  railPrefixes: string[];
}

function transcriptPathFor(runDir: string, row: RawRow): string {
  return join(runDir, "transcripts", `${row.caseId}.${row.treatmentId}.${row.repetition}.jsonl`);
}

function readTranscriptIfPresent(path: string): string | undefined {
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

async function judgeRow(row: RawRow, cases: CaseManifest[], corpusDir: string, contamination: ContaminationCheck | undefined): Promise<JudgedRow> {
  const { contaminated, consultedRail } = classifyRow(row, contamination);
  if (row.timedOut === true) return { row, judge: timedOutJudgeResult(), contaminated, consultedRail };
  if (row.agentError !== undefined) return { row, judge: erroredJudgeResult(), contaminated, consultedRail };

  const kase = findCase(cases, row.caseId);
  const beforeSource = readBeforeSource(corpusDir, kase);
  const afterSource = row.files[kase.entry];
  const entryChanged = entryChangedFor(beforeSource, afterSource);

  const before = await computeMetrics(kase.lang, kase.entry, beforeSource);

  const createdFiles = createdFilesOf(kase, row.files);
  const scan = scanReferences({ lang: referenceLang(kase.lang), entry: kase.entry, files: row.files, created: createdFiles });
  assertNoDroppedReferences(row, scan.unresolved);
  const after = await aggregateAfterMetrics(kase.lang, [kase.entry, ...scan.referenced], row.files);

  const probesPassed = shouldRunProbes(entryChanged, after, afterSource) ? runCaseProbes(kase, afterSource, row.files) : undefined;

  const judge = buildJudgeResult(before, after, entryChanged, probesPassed, createdFiles, scan.referenced, kase.genuineDpMax);
  return { row, judge, contaminated, consultedRail };
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
    meanRailFirings: null,
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

function zeroRailFirings(): Record<RuleName, number> {
  return Object.fromEntries(RULE_NAMES.map((rule) => [rule, 0])) as Record<RuleName, number>;
}

interface CostAccumulator {
  durationSum: number;
  turnsSum: number;
  tokensInSum: number;
  tokensOutSum: number;
  railFiringsSum: Record<RuleName, number>;
  available: number;
}

function newCostAccumulator(): CostAccumulator {
  return { durationSum: 0, turnsSum: 0, tokensInSum: 0, tokensOutSum: 0, railFiringsSum: zeroRailFirings(), available: 0 };
}

function costFieldsPresent(row: RawRow): row is RawRow & { turns: number; tokensIn: number; tokensOut: number; railFirings: Record<RuleName, number> } {
  return row.turns !== undefined && row.tokensIn !== undefined && row.tokensOut !== undefined && row.railFirings !== undefined;
}

function addCostMetrics(acc: CostAccumulator, row: RawRow): void {
  acc.durationSum += row.durationMs;
  if (!costFieldsPresent(row)) return;

  acc.available += 1;
  acc.turnsSum += row.turns;
  acc.tokensInSum += row.tokensIn;
  acc.tokensOutSum += row.tokensOut;
  for (const rule of RULE_NAMES) acc.railFiringsSum[rule] += row.railFirings[rule];
}

function meanOf(sum: number, count: number): number | null {
  return count === 0 ? null : sum / count;
}

interface CostSummary {
  meanDurationMs: number | null;
  meanTurns: number | null;
  meanTokensIn: number | null;
  meanTokensOut: number | null;
  meanRailFirings: Record<RuleName, number> | null;
  costAvailable: number;
}

function finalizeCost(acc: CostAccumulator, totalRows: number): CostSummary {
  const meanRailFirings =
    acc.available === 0 ? null : (Object.fromEntries(RULE_NAMES.map((rule) => [rule, acc.railFiringsSum[rule] / acc.available])) as Record<RuleName, number>);

  return {
    meanDurationMs: meanOf(acc.durationSum, totalRows),
    meanTurns: meanOf(acc.turnsSum, acc.available),
    meanTokensIn: meanOf(acc.tokensInSum, acc.available),
    meanTokensOut: meanOf(acc.tokensOutSum, acc.available),
    meanRailFirings,
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
  return `| ${treatmentCell(row)} | ${row.total} | ${c["genuine-fix"]} | ${c.gamed} | ${c["bar-missed"]} | ${c.untouched} | ${c.broken} | ${c["behavior-broken"]} | ${c.errored} | ${c["timed-out"]} | ${row.withCreatedFiles} | ${row.contaminated} | ${row.railConsults} | ${formatPercent(genuineRate(row))} | ${formatMeanDpReduction(row.meanDpReduction)} | ${formatMeanMs(row.meanDurationMs)} | ${formatMean(row.meanTurns)} | ${formatMean(row.meanTokensIn)} | ${formatMean(row.meanTokensOut)} | ${formatNudgesPerRepetition(row.meanRailFirings)} |`;
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

export interface JudgedJsonlRow {
  caseId: string;
  treatmentId: string;
  repetition: number;
  verdict: Verdict;
  gamedReason?: GamedReason;
  contaminated: boolean;
  consultedRail: boolean;
  dpBefore: number;
  dpAfter: number;
  probesPassed?: boolean;
  turns?: number;
  tokensIn?: number;
  tokensOut?: number;
  railFirings?: Record<RuleName, number>;
  durationMs: number;
  timedOut: boolean;
}

export function toJudgedJsonlRow(judgedRow: JudgedRow): JudgedJsonlRow {
  const { row, judge, contaminated, consultedRail } = judgedRow;
  return {
    caseId: row.caseId,
    treatmentId: row.treatmentId,
    repetition: row.repetition,
    verdict: judge.verdict,
    ...(judge.gamedReason !== undefined ? { gamedReason: judge.gamedReason } : {}),
    contaminated,
    consultedRail,
    dpBefore: judge.before.decisionPoints,
    dpAfter: judge.after.decisionPoints,
    ...(judge.probesPassed !== undefined ? { probesPassed: judge.probesPassed } : {}),
    ...(row.turns !== undefined ? { turns: row.turns } : {}),
    ...(row.tokensIn !== undefined ? { tokensIn: row.tokensIn } : {}),
    ...(row.tokensOut !== undefined ? { tokensOut: row.tokensOut } : {}),
    ...(row.railFirings !== undefined ? { railFirings: row.railFirings } : {}),
    durationMs: row.durationMs,
    timedOut: row.timedOut,
  };
}

function writeJudgedJsonl(runDir: string, judged: JudgedRow[]): void {
  const content = judged.map((judgedRow) => JSON.stringify(toJudgedJsonlRow(judgedRow))).join("\n") + "\n";
  writeFileSync(join(runDir, JUDGED_FILENAME), content);
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

export interface ArmDeliverySummary {
  treatmentId: string;
  repetitions: number;
  liveFirings: number;
  shadowFirings: number;
  promptCarried: boolean;
}

export type DeliveryValidity =
  | { kind: "unstamped"; warning: string }
  | { kind: "invalid"; violations: DeliveryViolation[] }
  | { kind: "valid"; arms: ArmDeliverySummary[] };

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
  return promptCarriedArmMessage(kase, packContent);
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
      promptNotCarriedViolation(row, `${rowLabel(row)}: opening prompt does not carry the arm's message — delivery: "prompt" requires the arm's phrasing inside the sent task`),
    );
  }

  return violations;
}

function armRowsByTreatment(rows: RawRow[]): Map<string, RawRow[]> {
  const arms = new Map<string, RawRow[]>();
  for (const row of rows) {
    const armRows = arms.get(row.treatmentId);
    if (armRows === undefined) arms.set(row.treatmentId, [row]);
    else armRows.push(row);
  }
  return arms;
}

function unionDeliveredRules(rows: RawRow[], pick: (delivered: NonNullable<RawRow["delivered"]>) => string[]): string[] {
  const rules = new Set<string>();
  for (const row of rows) {
    if (row.delivered === undefined) continue;
    for (const rule of pick(row.delivered)) rules.add(rule);
  }
  return [...rules];
}

function sumFirings(rows: RawRow[], pick: (row: RawRow) => Record<RuleName, number> | undefined): number {
  let total = 0;
  for (const row of rows) {
    const firings = pick(row);
    if (firings === undefined) continue;
    for (const count of Object.values(firings)) total += count;
  }
  return total;
}

function firingFloorViolation(
  kind: Extract<DeliveryViolationKind, "live-rules-silent" | "shadow-rules-silent">,
  treatmentId: string,
  rules: string[],
  repetitions: number,
): DeliveryViolation {
  const label = kind === "live-rules-silent" ? "live" : "shadow";
  return { kind, treatmentId, message: `${treatmentId}: ${label} rules ${rules.join(", ")} were delivered but never fired across ${repetitions} rows` };
}

function firingFloorViolations(treatmentId: string, armRows: RawRow[], manifest: TreatmentManifest | undefined): DeliveryViolation[] {
  if (manifest?.expectedZeroFirings === true) return [];
  if (manifest?.delivery === "prompt") return [];

  const violations: DeliveryViolation[] = [];

  const liveRules = unionDeliveredRules(armRows, (d) => d.liveRules);
  if (liveRules.length > 0 && sumFirings(armRows, (row) => row.railFirings) === 0) {
    violations.push(firingFloorViolation("live-rules-silent", treatmentId, liveRules, armRows.length));
  }

  const shadowRules = unionDeliveredRules(armRows, (d) => d.shadowRules);
  if (shadowRules.length > 0 && sumFirings(armRows, (row) => row.shadowFirings) === 0) {
    violations.push(firingFloorViolation("shadow-rules-silent", treatmentId, shadowRules, armRows.length));
  }

  return violations;
}

function armSummaryFor(treatmentId: string, armRows: RawRow[], manifest: TreatmentManifest | undefined): ArmDeliverySummary {
  return {
    treatmentId,
    repetitions: armRows.length,
    liveFirings: sumFirings(armRows, (row) => row.railFirings),
    shadowFirings: sumFirings(armRows, (row) => row.shadowFirings),
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
  const arms = [...armRowsByTreatment(rows)];

  const violations = [
    ...notDeliveredViolations(rows),
    ...missingStampViolations(rows, treatmentById),
    ...promptCarriedViolations(rows, treatmentById, treatmentsDir, caseById),
    ...arms.flatMap(([treatmentId, armRows]) => firingFloorViolations(treatmentId, armRows, treatmentById.get(treatmentId))),
  ];
  if (violations.length > 0) return { kind: "invalid", violations };

  const armSummaries = arms
    .map(([treatmentId, armRows]) => armSummaryFor(treatmentId, armRows, treatmentById.get(treatmentId)))
    .sort((a, b) => a.treatmentId.localeCompare(b.treatmentId));
  return { kind: "valid", arms: armSummaries };
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

function formatDeliveryValidityBlock(arms: ArmDeliverySummary[]): string {
  const lines = arms.map(
    (a) => `  ${a.treatmentId}: repetitions=${a.repetitions} liveFirings=${a.liveFirings} shadowFirings=${a.shadowFirings} delivered=${a.promptCarried ? "prompt" : "ok"}`,
  );
  return [...lines, ""].join("\n");
}

function deliveryStdoutPrefix(validity: Exclude<DeliveryValidity, { kind: "invalid" }>): string {
  if (validity.kind === "unstamped") return `${validity.warning}\n\n`;
  return `delivery validity:\n${formatDeliveryValidityBlock(validity.arms)}\n`;
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
  writeJudgedJsonl(opts.runDir, judged);
  const table = formatMarkdown(summary);
  const validityPrefix = deliveryStdoutPrefix(validity.result);

  if (opts.compareRunDir === undefined) return { status: OK_STATUS, stdout: `${validityPrefix}${table}` };

  const compareSection = await buildCompareSection(parsedRaw.rows, summary, opts.compareRunDir, opts.corpusDir, judgeEnv.env, tierMap);
  if ("error" in compareSection) return { status: ERROR_STATUS, stdout: compareSection.error };

  return { status: OK_STATUS, stdout: `${validityPrefix}${compareSection.text}\n${table}` };
}
