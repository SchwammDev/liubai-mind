import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Lang, RuleName } from "../contract.ts";
import { RULE } from "../contract.ts";
import type { CaseManifest, Probe, RawRow, Verdict } from "./eval-contract.ts";
import { loadCases, declaredFiles } from "./corpus.ts";
import { runProbes } from "./probes.ts";
import { sourceParses } from "./parse-check.ts";
import { readRawJsonl, judgeRows, runScore, probeLang } from "./score.ts";

export type FollowUpVerdict = "extended" | "extension-failed" | "regressed" | "broken" | "untouched" | "errored" | "timed-out";

export interface FollowUpJudgeResult {
  verdict: FollowUpVerdict;
  linesAdded: number;
  linesRemoved: number;
}

export interface JudgedFollowUpRow {
  row: RawRow;
  judge: FollowUpJudgeResult;
  stratum: string;
}

export interface FollowUpSummaryRow {
  touch: "second";
  treatmentId: string;
  caseId: string | null;
  stratum: string | null;
  counts: Record<FollowUpVerdict, number>;
  total: number;
  extensionSuccessRate: number | null;
  meanLinesAdded: number | null;
  meanLinesRemoved: number | null;
  meanTurns: number | null;
  meanNudgesTotal: number | null;
  costAvailable: number;
}

const FOLLOW_UP_VERDICTS: readonly FollowUpVerdict[] = ["extended", "extension-failed", "regressed", "broken", "untouched", "errored", "timed-out"];
const RULE_NAMES: readonly RuleName[] = Object.values(RULE);
const SUMMARY_FILENAME = "summary.jsonl";
const CONTROL_STRATUM = "control";

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsLength(a: string[], b: string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    previous = current;
  }
  return previous[b.length]!;
}

export interface DiffCounts {
  linesAdded: number;
  linesRemoved: number;
}

function changedLineCounts(before: string, after: string): DiffCounts {
  if (before === after) return { linesAdded: 0, linesRemoved: 0 };
  const a = splitLines(before);
  const b = splitLines(after);
  const common = lcsLength(a, b);
  return { linesAdded: b.length - common, linesRemoved: a.length - common };
}

export function computeDiffCounts(seedFiles: Record<string, string>, finalFiles: Record<string, string>): DiffCounts {
  const keys = new Set([...Object.keys(seedFiles), ...Object.keys(finalFiles)]);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const key of keys) {
    const counts = changedLineCounts(seedFiles[key] ?? "", finalFiles[key] ?? "");
    linesAdded += counts.linesAdded;
    linesRemoved += counts.linesRemoved;
  }
  return { linesAdded, linesRemoved };
}

function isSourcePath(path: string, lang: CaseManifest["lang"]): boolean {
  if (path.startsWith("playground/")) return false;
  if (lang === "typescript") return path.endsWith(".ts");
  if (lang === "python") return path.endsWith(".py");
  return false;
}

function filterToSourceFiles(files: Record<string, string>, lang: CaseManifest["lang"]): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([path]) => isSourcePath(path, lang)));
}

export function sourceDiffCounts(seedFiles: Record<string, string>, finalFiles: Record<string, string>, lang: CaseManifest["lang"]): DiffCounts {
  return computeDiffCounts(filterToSourceFiles(seedFiles, lang), filterToSourceFiles(finalFiles, lang));
}

function pristineFiles(corpusDir: string, kase: CaseManifest): Record<string, string> {
  const stripped = declaredFiles(kase);
  const files: Record<string, string> = {};
  kase.files.forEach((file, i) => {
    files[stripped[i]!] = readFileSync(join(corpusDir, kase.id, file), "utf8");
  });
  return files;
}

function filesAreIdentical(seed: Record<string, string>, final: Record<string, string>): boolean {
  const seedKeys = Object.keys(seed);
  if (seedKeys.length !== Object.keys(final).length) return false;
  return seedKeys.every((key) => final[key] === seed[key]);
}

function probesPassFor(kase: CaseManifest, probes: Probe[], entrySource: string, files: Record<string, string>): boolean {
  const outcome = runProbes({
    lang: probeLang(kase.lang),
    entryFilename: kase.entry,
    source: entrySource,
    entrySymbol: kase.entrySymbol,
    probes,
    files,
    compare: "subset",
  });
  return outcome.passed;
}

function classifyFollowUpVerdict(kase: CaseManifest, row: RawRow, seedFiles: Record<string, string>): FollowUpVerdict {
  if (row.timedOut === true) return "timed-out";
  if (row.agentError !== undefined) return "errored";

  const entrySource = row.files[kase.entry];
  if (entrySource === undefined || !sourceParses(entrySource, probeLang(kase.lang))) return "broken";

  if (filesAreIdentical(seedFiles, row.files)) return "untouched";

  if (!probesPassFor(kase, kase.probes, entrySource, row.files)) return "regressed";
  if (!probesPassFor(kase, kase.extension!.probes, entrySource, row.files)) return "extension-failed";

  return "extended";
}

function sourceRowKey(caseId: string, treatmentId: string, repetition: number): string {
  return `${caseId}\0${treatmentId}\0${repetition}`;
}

function indexSourceRows(sourceRows: RawRow[]): Map<string, RawRow> {
  const map = new Map<string, RawRow>();
  for (const row of sourceRows) map.set(sourceRowKey(row.caseId, row.treatmentId, row.repetition), row);
  return map;
}

function findSourceRow(sourceRowsByKey: Map<string, RawRow>, row: RawRow): RawRow {
  const info = row.followUp;
  if (info === undefined || info.control || info.sourceRepetition === null) {
    throw new Error(`follow-up-score: ${row.caseId}/${row.treatmentId}#${row.repetition} is not a seeded follow-up row`);
  }
  const found = sourceRowsByKey.get(sourceRowKey(row.caseId, row.treatmentId, info.sourceRepetition));
  if (found === undefined) {
    throw new Error(`follow-up-score: source row not found for ${row.caseId}/${row.treatmentId}#${info.sourceRepetition}`);
  }
  return found;
}

function seedFilesFor(row: RawRow, kase: CaseManifest, corpusDir: string, sourceRowsByKey: Map<string, RawRow>): Record<string, string> {
  if (row.followUp === undefined) {
    throw new Error(`follow-up-score: ${row.caseId}/${row.treatmentId}#${row.repetition} has no followUp info`);
  }
  return row.followUp.control ? pristineFiles(corpusDir, kase) : findSourceRow(sourceRowsByKey, row).files;
}

async function sourceVerdictOf(
  row: RawRow,
  corpusDir: string,
  sourceRowsByKey: Map<string, RawRow>,
  cache: Map<string, Verdict>,
): Promise<Verdict> {
  const sourceRow = findSourceRow(sourceRowsByKey, row);
  const key = sourceRowKey(sourceRow.caseId, sourceRow.treatmentId, sourceRow.repetition);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const [judged] = await judgeRows([sourceRow], corpusDir);
  const verdict = judged!.judge.verdict;
  cache.set(key, verdict);
  return verdict;
}

function caseFor(cases: CaseManifest[], caseId: string): CaseManifest {
  const kase = cases.find((c) => c.id === caseId);
  if (kase === undefined) throw new Error(`follow-up-score: unknown case id in raw row: ${caseId}`);
  if (kase.extension === undefined) throw new Error(`follow-up-score: case has no extension.json: ${caseId}`);
  return kase;
}

export async function judgeFollowUpRows(rows: RawRow[], sourceRows: RawRow[], corpusDir: string): Promise<JudgedFollowUpRow[]> {
  const cases = loadCases(corpusDir);
  if ("error" in cases) throw new Error(`follow-up-score: failed to load corpus: ${cases.error}`);

  const sourceRowsByKey = indexSourceRows(sourceRows);
  const sourceVerdictCache = new Map<string, Verdict>();

  const judged: JudgedFollowUpRow[] = [];
  for (const row of rows) {
    const kase = caseFor(cases, row.caseId);
    const seedFiles = seedFilesFor(row, kase, corpusDir, sourceRowsByKey);
    const verdict = classifyFollowUpVerdict(kase, row, seedFiles);
    const { linesAdded, linesRemoved } = sourceDiffCounts(seedFiles, row.files, kase.lang);
    const stratum = row.followUp?.control ? CONTROL_STRATUM : await sourceVerdictOf(row, corpusDir, sourceRowsByKey, sourceVerdictCache);
    judged.push({ row, judge: { verdict, linesAdded, linesRemoved }, stratum });
  }
  return judged;
}

function emptyFollowUpCounts(): Record<FollowUpVerdict, number> {
  return Object.fromEntries(FOLLOW_UP_VERDICTS.map((v) => [v, 0])) as Record<FollowUpVerdict, number>;
}

interface FollowUpAccumulator {
  counts: Record<FollowUpVerdict, number>;
  total: number;
  linesAddedSum: number;
  linesRemovedSum: number;
  turnsSum: number;
  nudgesTotalSum: number;
  costAvailable: number;
}

function newAccumulator(): FollowUpAccumulator {
  return { counts: emptyFollowUpCounts(), total: 0, linesAddedSum: 0, linesRemovedSum: 0, turnsSum: 0, nudgesTotalSum: 0, costAvailable: 0 };
}

function nudgesTotal(nudges: Record<RuleName, number>): number {
  return RULE_NAMES.reduce((sum, rule) => sum + nudges[rule], 0);
}

function costFieldsPresent(row: RawRow): row is RawRow & { turns: number; nudges: Record<RuleName, number> } {
  return row.turns !== undefined && row.nudges !== undefined;
}

function addRow(acc: FollowUpAccumulator, judged: JudgedFollowUpRow): void {
  acc.counts[judged.judge.verdict] += 1;
  acc.total += 1;
  acc.linesAddedSum += judged.judge.linesAdded;
  acc.linesRemovedSum += judged.judge.linesRemoved;
  if (!costFieldsPresent(judged.row)) return;
  acc.costAvailable += 1;
  acc.turnsSum += judged.row.turns;
  acc.nudgesTotalSum += nudgesTotal(judged.row.nudges);
}

function meanOf(sum: number, count: number): number | null {
  return count === 0 ? null : sum / count;
}

function extensionSuccessRateOf(counts: Record<FollowUpVerdict, number>, total: number): number | null {
  const denominator = total - counts.errored - counts["timed-out"];
  return denominator === 0 ? null : (counts.extended / denominator) * 100;
}

function finalizeRow(treatmentId: string, caseId: string | null, stratum: string | null, acc: FollowUpAccumulator): FollowUpSummaryRow {
  return {
    touch: "second",
    treatmentId,
    caseId,
    stratum,
    counts: acc.counts,
    total: acc.total,
    extensionSuccessRate: extensionSuccessRateOf(acc.counts, acc.total),
    meanLinesAdded: meanOf(acc.linesAddedSum, acc.total),
    meanLinesRemoved: meanOf(acc.linesRemovedSum, acc.total),
    meanTurns: meanOf(acc.turnsSum, acc.costAvailable),
    meanNudgesTotal: meanOf(acc.nudgesTotalSum, acc.costAvailable),
    costAvailable: acc.costAvailable,
  };
}

function getOrInit(map: Map<string, FollowUpAccumulator>, key: string): FollowUpAccumulator {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = newAccumulator();
  map.set(key, created);
  return created;
}

export function aggregateFollowUp(judged: JudgedFollowUpRow[]): FollowUpSummaryRow[] {
  const overall = new Map<string, FollowUpAccumulator>();
  const stratumBuckets = new Map<string, FollowUpAccumulator>();
  const detail = new Map<string, FollowUpAccumulator>();
  const stratumMeta = new Map<string, { treatmentId: string; stratum: string }>();
  const detailMeta = new Map<string, { treatmentId: string; caseId: string }>();

  for (const j of judged) {
    const { treatmentId, caseId } = j.row;

    addRow(getOrInit(overall, treatmentId), j);

    const stratumKey = `${treatmentId}\0${j.stratum}`;
    stratumMeta.set(stratumKey, { treatmentId, stratum: j.stratum });
    addRow(getOrInit(stratumBuckets, stratumKey), j);

    const detailKey = `${treatmentId}\0${caseId}`;
    detailMeta.set(detailKey, { treatmentId, caseId });
    addRow(getOrInit(detail, detailKey), j);
  }

  const overallRows = [...overall.entries()].map(([treatmentId, acc]) => finalizeRow(treatmentId, null, null, acc));
  const stratumRows = [...stratumBuckets.entries()].map(([key, acc]) => {
    const meta = stratumMeta.get(key)!;
    return finalizeRow(meta.treatmentId, null, meta.stratum, acc);
  });
  const detailRows = [...detail.entries()].map(([key, acc]) => {
    const meta = detailMeta.get(key)!;
    return finalizeRow(meta.treatmentId, meta.caseId, null, acc);
  });

  return [...overallRows, ...stratumRows, ...detailRows];
}

function formatPercent(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(1)}%`;
}

function formatMean(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function treatmentCell(row: FollowUpSummaryRow): string {
  return row.stratum === null ? row.treatmentId : `${row.treatmentId} [${row.stratum}]`;
}

function markdownRow(row: FollowUpSummaryRow): string {
  const c = row.counts;
  return `| ${treatmentCell(row)} | ${row.total} | ${c.extended} | ${c["extension-failed"]} | ${c.regressed} | ${c.broken} | ${c.untouched} | ${c.errored} | ${c["timed-out"]} | ${formatPercent(row.extensionSuccessRate)} | ${formatMean(row.meanLinesAdded)} | ${formatMean(row.meanLinesRemoved)} | ${formatMean(row.meanTurns)} | ${formatMean(row.meanNudgesTotal)} |`;
}

export function formatFollowUpMarkdown(summary: FollowUpSummaryRow[]): string {
  const rollups = summary.filter((r) => r.caseId === null);
  const header =
    "| treatment | n | extended | extension-failed | regressed | broken | untouched | errored | timed-out | extension % | mean added | mean removed | mean turns | mean nudges |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  return [header, divider, ...rollups.map(markdownRow)].join("\n");
}

function writeFollowUpSummaryJsonl(runDir: string, summary: FollowUpSummaryRow[]): void {
  const content = summary.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(runDir, SUMMARY_FILENAME), content);
}

export interface FollowUpScoreOpts {
  runDir: string;
  sourceRunDir: string;
  corpusDir: string;
}

export async function runFollowUpScore(opts: FollowUpScoreOpts): Promise<{ status: number; stdout: string }> {
  const parsedRaw = readRawJsonl(opts.runDir);
  if ("error" in parsedRaw) return { status: 1, stdout: parsedRaw.error };

  const sourceParsed = readRawJsonl(opts.sourceRunDir);
  if ("error" in sourceParsed) return { status: 1, stdout: sourceParsed.error };

  let judged: JudgedFollowUpRow[];
  try {
    judged = await judgeFollowUpRows(parsedRaw.rows, sourceParsed.rows, opts.corpusDir);
  } catch (err) {
    return { status: 1, stdout: err instanceof Error ? err.message : String(err) };
  }

  const summary = aggregateFollowUp(judged);
  writeFollowUpSummaryJsonl(opts.runDir, summary);
  return { status: 0, stdout: formatFollowUpMarkdown(summary) };
}

export type TouchKind = { kind: "first" } | { kind: "second"; sourceRun: string } | { error: string };

export function touchKindOf(rows: RawRow[]): TouchKind {
  const withFollowUp = rows.filter((row) => row.followUp !== undefined);
  if (withFollowUp.length === 0) return { kind: "first" };
  if (withFollowUp.length !== rows.length) {
    return { error: "score: run mixes single-task and follow-up rows; run follow-up scoring or single-task scoring, not both" };
  }

  const sourceRuns = new Set(withFollowUp.map((row) => row.followUp!.sourceRun));
  if (sourceRuns.size > 1) {
    return { error: `score: follow-up run mixes multiple source runs: ${[...sourceRuns].sort().join(", ")}` };
  }

  return { kind: "second", sourceRun: [...sourceRuns][0]! };
}

type RunScoreOpts = Parameters<typeof runScore>[0];
type RunScoreResult = Awaited<ReturnType<typeof runScore>>;

export async function routeScore(opts: RunScoreOpts, runsRoot: string): Promise<RunScoreResult> {
  const parsedRaw = readRawJsonl(opts.runDir);
  if ("error" in parsedRaw) return { status: 1, stdout: parsedRaw.error };

  const kind = touchKindOf(parsedRaw.rows);
  if ("error" in kind) return { status: 1, stdout: kind.error };
  if (kind.kind === "first") return runScore(opts);

  if (opts.compareRunDir !== undefined) {
    return { status: 1, stdout: "follow-up-score: --compare is not supported for follow-up runs" };
  }

  return runFollowUpScore({ runDir: opts.runDir, corpusDir: opts.corpusDir, sourceRunDir: join(runsRoot, kind.sourceRun) });
}
