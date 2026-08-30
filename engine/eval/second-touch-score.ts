import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Lang, RuleName } from "../contract.ts";
import { RULE } from "../contract.ts";
import type { CaseManifest, Probe, RawRow, Verdict } from "./eval-contract.ts";
import { loadCases, declaredFiles } from "./corpus.ts";
import { runProbes } from "./probes.ts";
import { sourceParses } from "./parse-check.ts";
import { readRawJsonl, judgeRows, runScore, probeLang } from "./score.ts";

export type SecondTouchVerdict = "extended" | "extension-failed" | "regressed" | "broken" | "untouched" | "errored";

export interface SecondTouchJudgeResult {
  verdict: SecondTouchVerdict;
  linesAdded: number;
  linesRemoved: number;
}

export interface JudgedSecondTouchRow {
  row: RawRow;
  judge: SecondTouchJudgeResult;
  stratum: string;
}

export interface SecondTouchSummaryRow {
  touch: "second";
  conditionId: string;
  caseId: string | null;
  stratum: string | null;
  counts: Record<SecondTouchVerdict, number>;
  total: number;
  extensionSuccessRate: number | null;
  meanLinesAdded: number | null;
  meanLinesRemoved: number | null;
  meanTurns: number | null;
  meanRailFiringsTotal: number | null;
  costAvailable: number;
}

const SECOND_TOUCH_VERDICTS: readonly SecondTouchVerdict[] = ["extended", "extension-failed", "regressed", "broken", "untouched", "errored"];
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

interface DiffCounts {
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

function classifySecondTouchVerdict(kase: CaseManifest, row: RawRow, seedFiles: Record<string, string>): SecondTouchVerdict {
  if (row.agentError !== undefined) return "errored";

  const entrySource = row.files[kase.entry];
  if (entrySource === undefined || !sourceParses(entrySource, probeLang(kase.lang))) return "broken";

  if (filesAreIdentical(seedFiles, row.files)) return "untouched";

  if (!probesPassFor(kase, kase.probes, entrySource, row.files)) return "regressed";
  if (!probesPassFor(kase, kase.extension!.probes, entrySource, row.files)) return "extension-failed";

  return "extended";
}

function sourceRowKey(caseId: string, conditionId: string, rep: number): string {
  return `${caseId}\0${conditionId}\0${rep}`;
}

function indexSourceRows(sourceRows: RawRow[]): Map<string, RawRow> {
  const map = new Map<string, RawRow>();
  for (const row of sourceRows) map.set(sourceRowKey(row.caseId, row.conditionId, row.rep), row);
  return map;
}

function findSourceRow(sourceRowsByKey: Map<string, RawRow>, row: RawRow): RawRow {
  const info = row.secondTouch;
  if (info === undefined || info.control || info.sourceRep === null) {
    throw new Error(`second-touch-score: ${row.caseId}/${row.conditionId}#${row.rep} is not a seeded second-touch row`);
  }
  const found = sourceRowsByKey.get(sourceRowKey(row.caseId, row.conditionId, info.sourceRep));
  if (found === undefined) {
    throw new Error(`second-touch-score: source row not found for ${row.caseId}/${row.conditionId}#${info.sourceRep}`);
  }
  return found;
}

function seedFilesFor(row: RawRow, kase: CaseManifest, corpusDir: string, sourceRowsByKey: Map<string, RawRow>): Record<string, string> {
  if (row.secondTouch === undefined) {
    throw new Error(`second-touch-score: ${row.caseId}/${row.conditionId}#${row.rep} has no secondTouch info`);
  }
  return row.secondTouch.control ? pristineFiles(corpusDir, kase) : findSourceRow(sourceRowsByKey, row).files;
}

async function sourceVerdictOf(
  row: RawRow,
  corpusDir: string,
  sourceRowsByKey: Map<string, RawRow>,
  cache: Map<string, Verdict>,
): Promise<Verdict> {
  const sourceRow = findSourceRow(sourceRowsByKey, row);
  const key = sourceRowKey(sourceRow.caseId, sourceRow.conditionId, sourceRow.rep);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const [judged] = await judgeRows([sourceRow], corpusDir);
  const verdict = judged!.judge.verdict;
  cache.set(key, verdict);
  return verdict;
}

function caseFor(cases: CaseManifest[], caseId: string): CaseManifest {
  const kase = cases.find((c) => c.id === caseId);
  if (kase === undefined) throw new Error(`second-touch-score: unknown case id in raw row: ${caseId}`);
  if (kase.extension === undefined) throw new Error(`second-touch-score: case has no extension.json: ${caseId}`);
  return kase;
}

export async function judgeSecondTouchRows(rows: RawRow[], sourceRows: RawRow[], corpusDir: string): Promise<JudgedSecondTouchRow[]> {
  const cases = loadCases(corpusDir);
  if ("error" in cases) throw new Error(`second-touch-score: failed to load corpus: ${cases.error}`);

  const sourceRowsByKey = indexSourceRows(sourceRows);
  const sourceVerdictCache = new Map<string, Verdict>();

  const judged: JudgedSecondTouchRow[] = [];
  for (const row of rows) {
    const kase = caseFor(cases, row.caseId);
    const seedFiles = seedFilesFor(row, kase, corpusDir, sourceRowsByKey);
    const verdict = classifySecondTouchVerdict(kase, row, seedFiles);
    const { linesAdded, linesRemoved } = computeDiffCounts(seedFiles, row.files);
    const stratum = row.secondTouch?.control ? CONTROL_STRATUM : await sourceVerdictOf(row, corpusDir, sourceRowsByKey, sourceVerdictCache);
    judged.push({ row, judge: { verdict, linesAdded, linesRemoved }, stratum });
  }
  return judged;
}

function emptySecondTouchCounts(): Record<SecondTouchVerdict, number> {
  return Object.fromEntries(SECOND_TOUCH_VERDICTS.map((v) => [v, 0])) as Record<SecondTouchVerdict, number>;
}

interface SecondTouchAccumulator {
  counts: Record<SecondTouchVerdict, number>;
  total: number;
  linesAddedSum: number;
  linesRemovedSum: number;
  turnsSum: number;
  railFiringsTotalSum: number;
  costAvailable: number;
}

function newAccumulator(): SecondTouchAccumulator {
  return { counts: emptySecondTouchCounts(), total: 0, linesAddedSum: 0, linesRemovedSum: 0, turnsSum: 0, railFiringsTotalSum: 0, costAvailable: 0 };
}

function railFiringsTotal(railFirings: Record<RuleName, number>): number {
  return RULE_NAMES.reduce((sum, rule) => sum + railFirings[rule], 0);
}

function costFieldsPresent(row: RawRow): row is RawRow & { turns: number; railFirings: Record<RuleName, number> } {
  return row.turns !== undefined && row.railFirings !== undefined;
}

function addRow(acc: SecondTouchAccumulator, judged: JudgedSecondTouchRow): void {
  acc.counts[judged.judge.verdict] += 1;
  acc.total += 1;
  acc.linesAddedSum += judged.judge.linesAdded;
  acc.linesRemovedSum += judged.judge.linesRemoved;
  if (!costFieldsPresent(judged.row)) return;
  acc.costAvailable += 1;
  acc.turnsSum += judged.row.turns;
  acc.railFiringsTotalSum += railFiringsTotal(judged.row.railFirings);
}

function meanOf(sum: number, count: number): number | null {
  return count === 0 ? null : sum / count;
}

function extensionSuccessRateOf(counts: Record<SecondTouchVerdict, number>, total: number): number | null {
  const nonErrored = total - counts.errored;
  return nonErrored === 0 ? null : (counts.extended / nonErrored) * 100;
}

function finalizeRow(conditionId: string, caseId: string | null, stratum: string | null, acc: SecondTouchAccumulator): SecondTouchSummaryRow {
  return {
    touch: "second",
    conditionId,
    caseId,
    stratum,
    counts: acc.counts,
    total: acc.total,
    extensionSuccessRate: extensionSuccessRateOf(acc.counts, acc.total),
    meanLinesAdded: meanOf(acc.linesAddedSum, acc.total),
    meanLinesRemoved: meanOf(acc.linesRemovedSum, acc.total),
    meanTurns: meanOf(acc.turnsSum, acc.costAvailable),
    meanRailFiringsTotal: meanOf(acc.railFiringsTotalSum, acc.costAvailable),
    costAvailable: acc.costAvailable,
  };
}

function getOrInit(map: Map<string, SecondTouchAccumulator>, key: string): SecondTouchAccumulator {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = newAccumulator();
  map.set(key, created);
  return created;
}

export function aggregateSecondTouch(judged: JudgedSecondTouchRow[]): SecondTouchSummaryRow[] {
  const overall = new Map<string, SecondTouchAccumulator>();
  const stratumBuckets = new Map<string, SecondTouchAccumulator>();
  const detail = new Map<string, SecondTouchAccumulator>();
  const stratumMeta = new Map<string, { conditionId: string; stratum: string }>();
  const detailMeta = new Map<string, { conditionId: string; caseId: string }>();

  for (const j of judged) {
    const { conditionId, caseId } = j.row;

    addRow(getOrInit(overall, conditionId), j);

    const stratumKey = `${conditionId}\0${j.stratum}`;
    stratumMeta.set(stratumKey, { conditionId, stratum: j.stratum });
    addRow(getOrInit(stratumBuckets, stratumKey), j);

    const detailKey = `${conditionId}\0${caseId}`;
    detailMeta.set(detailKey, { conditionId, caseId });
    addRow(getOrInit(detail, detailKey), j);
  }

  const overallRows = [...overall.entries()].map(([conditionId, acc]) => finalizeRow(conditionId, null, null, acc));
  const stratumRows = [...stratumBuckets.entries()].map(([key, acc]) => {
    const meta = stratumMeta.get(key)!;
    return finalizeRow(meta.conditionId, null, meta.stratum, acc);
  });
  const detailRows = [...detail.entries()].map(([key, acc]) => {
    const meta = detailMeta.get(key)!;
    return finalizeRow(meta.conditionId, meta.caseId, null, acc);
  });

  return [...overallRows, ...stratumRows, ...detailRows];
}

function formatPercent(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(1)}%`;
}

function formatMean(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function conditionCell(row: SecondTouchSummaryRow): string {
  return row.stratum === null ? row.conditionId : `${row.conditionId} [${row.stratum}]`;
}

function markdownRow(row: SecondTouchSummaryRow): string {
  const c = row.counts;
  return `| ${conditionCell(row)} | ${row.total} | ${c.extended} | ${c["extension-failed"]} | ${c.regressed} | ${c.broken} | ${c.untouched} | ${c.errored} | ${formatPercent(row.extensionSuccessRate)} | ${formatMean(row.meanLinesAdded)} | ${formatMean(row.meanLinesRemoved)} | ${formatMean(row.meanTurns)} | ${formatMean(row.meanRailFiringsTotal)} |`;
}

export function formatSecondTouchMarkdown(summary: SecondTouchSummaryRow[]): string {
  const rollups = summary.filter((r) => r.caseId === null);
  const header =
    "| condition | n | extended | extension-failed | regressed | broken | untouched | errored | extension % | mean added | mean removed | mean turns | mean rails |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  return [header, divider, ...rollups.map(markdownRow)].join("\n");
}

function writeSecondTouchSummaryJsonl(runDir: string, summary: SecondTouchSummaryRow[]): void {
  const content = summary.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(join(runDir, SUMMARY_FILENAME), content);
}

export interface SecondTouchScoreOpts {
  runDir: string;
  sourceRunDir: string;
  corpusDir: string;
}

export async function runSecondTouchScore(opts: SecondTouchScoreOpts): Promise<{ status: number; stdout: string }> {
  const parsedRaw = readRawJsonl(opts.runDir);
  if ("error" in parsedRaw) return { status: 1, stdout: parsedRaw.error };

  const sourceParsed = readRawJsonl(opts.sourceRunDir);
  if ("error" in sourceParsed) return { status: 1, stdout: sourceParsed.error };

  let judged: JudgedSecondTouchRow[];
  try {
    judged = await judgeSecondTouchRows(parsedRaw.rows, sourceParsed.rows, opts.corpusDir);
  } catch (err) {
    return { status: 1, stdout: err instanceof Error ? err.message : String(err) };
  }

  const summary = aggregateSecondTouch(judged);
  writeSecondTouchSummaryJsonl(opts.runDir, summary);
  return { status: 0, stdout: formatSecondTouchMarkdown(summary) };
}

export type TouchKind = { kind: "first" } | { kind: "second"; sourceRun: string } | { error: string };

export function touchKindOf(rows: RawRow[]): TouchKind {
  const withSecondTouch = rows.filter((row) => row.secondTouch !== undefined);
  if (withSecondTouch.length === 0) return { kind: "first" };
  if (withSecondTouch.length !== rows.length) {
    return { error: "score: run mixes first-touch and second-touch rows; run second-touch scoring or first-touch scoring, not both" };
  }

  const sourceRuns = new Set(withSecondTouch.map((row) => row.secondTouch!.sourceRun));
  if (sourceRuns.size > 1) {
    return { error: `score: second-touch run mixes multiple source runs: ${[...sourceRuns].sort().join(", ")}` };
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
    return { status: 1, stdout: "second-touch-score: --compare is not supported for second-touch runs" };
  }

  return runSecondTouchScore({ runDir: opts.runDir, corpusDir: opts.corpusDir, sourceRunDir: join(runsRoot, kind.sourceRun) });
}
