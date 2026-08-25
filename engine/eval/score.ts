import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import type { Lang, Extracted } from "../contract.ts";
import type { CaseManifest } from "./eval-contract.ts";
import type { RawRow, Metrics, Verdict, GamedReason, JudgeResult, Provenance } from "./eval-contract.ts";
import { decisionPoints, classifyVerdict } from "./judge.ts";
import { countSilentHandlers } from "./silent-handlers.ts";
import { loadCases } from "./corpus.ts";
import { typescriptExtractor } from "../extract-typescript.ts";
import { pythonExtractor } from "../extract-python.ts";

export interface JudgedRow {
  row: RawRow;
  judge: JudgeResult;
}

export interface SummaryRow {
  conditionId: string;
  caseId: string | null;
  counts: Record<Verdict, number>;
  gamedReasons: Record<GamedReason, number>;
  total: number;
}

const VERDICTS: readonly Verdict[] = ["genuine-fix", "gamed", "no-reduction", "untouched", "broken", "behavior-broken", "errored"];
const GAMED_REASONS: readonly GamedReason[] = ["helper-split", "silent-handler"];
const SUMMARY_FILENAME = "summary.jsonl";
const RAW_FILENAME = "raw.jsonl";
const ERROR_STATUS = 1;
const OK_STATUS = 0;
const FALLBACK_AGENT_ERROR = "agent error";

function silentHandlerLang(lang: Lang): "typescript" | "python" {
  if (lang === "typescript") return "typescript";
  if (lang === "python") return "python";
  throw new Error(`score: unsupported lang for silent-handler detection: ${lang}`);
}

async function extractFunctions(lang: Lang, path: string, after: string): Promise<Extracted> {
  if (lang === "typescript") return await typescriptExtractor.extract({ path, after });
  if (lang === "python") return await pythonExtractor.extract({ path, after });
  throw new Error(`score: unsupported lang for extraction: ${lang}`);
}

const BROKEN_METRICS: Metrics = { decisionPoints: 0, nFunctions: 0, silentHandlers: 0, parsed: false };

async function computeMetrics(lang: Lang, path: string, source: string | undefined): Promise<Metrics> {
  if (source === undefined) return BROKEN_METRICS;

  try {
    const extracted = await extractFunctions(lang, path, source);
    return {
      decisionPoints: decisionPoints(extracted.functions),
      nFunctions: extracted.functions.length,
      silentHandlers: countSilentHandlers(source, silentHandlerLang(lang)),
      parsed: true,
    };
  } catch {
    return BROKEN_METRICS;
  }
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

function buildJudgeResult(before: Metrics, after: Metrics, entryChanged: boolean): JudgeResult {
  const { verdict, gamedReason } = classifyVerdict({ before, after, entryChanged });
  return { verdict, before, after, ...(gamedReason !== undefined ? { gamedReason } : {}) };
}

function erroredJudgeResult(): JudgeResult {
  return { verdict: "errored", before: BROKEN_METRICS, after: BROKEN_METRICS };
}

async function judgeRow(row: RawRow, cases: CaseManifest[], corpusDir: string): Promise<JudgedRow> {
  if (row.agentError !== undefined) return { row, judge: erroredJudgeResult() };

  const kase = findCase(cases, row.caseId);
  const beforeSource = readBeforeSource(corpusDir, kase);
  const afterSource = row.files[kase.entry];

  const before = await computeMetrics(kase.lang, kase.entry, beforeSource);
  const after = await computeMetrics(kase.lang, kase.entry, afterSource);

  const judge = buildJudgeResult(before, after, entryChangedFor(beforeSource, afterSource));
  return { row, judge };
}

export async function judgeRows(rows: RawRow[], corpusDir: string): Promise<JudgedRow[]> {
  const cases = loadCases(corpusDir);
  if ("error" in cases) throw new Error(`score: failed to load corpus: ${cases.error}`);

  const judged: JudgedRow[] = [];
  for (const row of rows) {
    judged.push(await judgeRow(row, cases, corpusDir));
  }
  return judged;
}

function emptyCounts(): Record<Verdict, number> {
  return Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
}

function emptyGamedReasons(): Record<GamedReason, number> {
  return Object.fromEntries(GAMED_REASONS.map((r) => [r, 0])) as Record<GamedReason, number>;
}

function newSummaryRow(conditionId: string, caseId: string | null): SummaryRow {
  return { conditionId, caseId, counts: emptyCounts(), gamedReasons: emptyGamedReasons(), total: 0 };
}

function addJudgeToRow(bucket: SummaryRow, judge: JudgeResult): void {
  bucket.counts[judge.verdict] += 1;
  bucket.total += 1;
  if (judge.gamedReason !== undefined) bucket.gamedReasons[judge.gamedReason] += 1;
}

function detailKey(conditionId: string, caseId: string): string {
  return `${conditionId}\0${caseId}`;
}

export function aggregate(judged: JudgedRow[]): SummaryRow[] {
  const rollups = new Map<string, SummaryRow>();
  const details = new Map<string, SummaryRow>();

  for (const { row, judge } of judged) {
    const rollup = rollups.get(row.conditionId) ?? newSummaryRow(row.conditionId, null);
    addJudgeToRow(rollup, judge);
    rollups.set(row.conditionId, rollup);

    const key = detailKey(row.conditionId, row.caseId);
    const detail = details.get(key) ?? newSummaryRow(row.conditionId, row.caseId);
    addJudgeToRow(detail, judge);
    details.set(key, detail);
  }

  return [...rollups.values(), ...details.values()];
}

function genuineRate(row: SummaryRow): number {
  return row.total === 0 ? 0 : (row.counts["genuine-fix"] / row.total) * 100;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function markdownRow(row: SummaryRow): string {
  const c = row.counts;
  return `| ${row.conditionId} | ${row.total} | ${c["genuine-fix"]} | ${c.gamed} | ${c["no-reduction"]} | ${c.untouched} | ${c.broken} | ${c["behavior-broken"]} | ${c.errored} | ${formatPercent(genuineRate(row))} |`;
}

export function formatMarkdown(summary: SummaryRow[]): string {
  const rollups = summary.filter((r) => r.caseId === null);
  const header = "| condition | n | genuine-fix | gamed | no-reduction | untouched | broken | behavior-broken | errored | genuine % |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  return [header, divider, ...rollups.map(markdownRow)].join("\n");
}

type ProvenanceField = { label: string; value: (p: Provenance) => string };

const PROVENANCE_FIELDS: readonly ProvenanceField[] = [
  { label: "model", value: (p) => p.model },
  { label: "phrasing pack", value: (p) => (p.phrasingPackHash === null ? "none" : p.phrasingPackHash.slice(0, 8)) },
  { label: "liubai sha", value: (p) => p.liubaiSha },
  { label: "python cc backend", value: (p) => p.pyCcBackend ?? "none" },
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

type ParsedRaw = { rows: RawRow[] } | { error: string };

function parseRawLine(line: string, lineNumber: number, runDir: string): { row: RawRow } | { error: string } {
  try {
    return { row: JSON.parse(line) as RawRow };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: `score: malformed raw.jsonl line ${lineNumber} in ${runDir}: ${reason}` };
  }
}

function readRawJsonl(runDir: string): ParsedRaw {
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

function python3Available(): boolean {
  const res = spawnSync("python3", ["--version"]);
  return res.error === undefined && res.status === 0;
}

function anyRowNeedsPython(rows: RawRow[], cases: CaseManifest[]): boolean {
  const langById = new Map(cases.map((c) => [c.id, c.lang]));
  return rows.some((row) => langById.get(row.caseId) === "python");
}

function ensurePythonAvailableIfNeeded(rows: RawRow[], corpusDir: string): { error: string } | undefined {
  const cases = loadCases(corpusDir);
  if ("error" in cases) return { error: `score: failed to load corpus: ${cases.error}` };

  if (anyRowNeedsPython(rows, cases) && !python3Available()) {
    return { error: "score: python3 is required to judge python cases but was not found on PATH" };
  }
  return undefined;
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
  return `${current.conditionId}: genuine ${compareRate} -> ${currentRate}`;
}

function genuineRateDeltaSection(currentSummary: SummaryRow[], compareSummary: SummaryRow[]): string[] {
  const compareByCondition = new Map(compareSummary.filter((r) => r.caseId === null).map((r) => [r.conditionId, r]));

  const lines: string[] = [];
  for (const current of currentSummary) {
    if (current.caseId !== null) continue;
    const compare = compareByCondition.get(current.conditionId);
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
): Promise<{ text: string } | { error: string }> {
  const compareParsed = readRawJsonl(compareRunDir);
  if ("error" in compareParsed) return compareParsed;

  const provenanceDiff = compareProvenance(
    currentRows.map((r) => r.provenance),
    compareParsed.rows.map((r) => r.provenance),
  );
  const provenanceLines = provenanceDiff.length > 0 ? provenanceDiff : ["provenance identical"];

  const compareJudged = await judgeRows(compareParsed.rows, corpusDir);
  const compareSummary = aggregate(compareJudged);
  const deltaLines = genuineRateDeltaSection(currentSummary, compareSummary);

  return { text: [...provenanceLines, "", ...deltaLines, ""].join("\n") };
}

export async function runScore(opts: {
  runDir: string;
  corpusDir: string;
  compareRunDir?: string;
}): Promise<{ status: number; stdout: string }> {
  const parsedRaw = readRawJsonl(opts.runDir);
  if ("error" in parsedRaw) return { status: ERROR_STATUS, stdout: parsedRaw.error };

  if (allRowsErrored(parsedRaw.rows)) {
    return { status: ERROR_STATUS, stdout: `score: every row in this run agent-errored; first: ${firstAgentError(parsedRaw.rows)}` };
  }

  const pythonCheck = ensurePythonAvailableIfNeeded(parsedRaw.rows, opts.corpusDir);
  if (pythonCheck !== undefined) return { status: ERROR_STATUS, stdout: pythonCheck.error };

  let judged: JudgedRow[];
  try {
    judged = await judgeRows(parsedRaw.rows, opts.corpusDir);
  } catch (err) {
    return { status: ERROR_STATUS, stdout: err instanceof Error ? err.message : String(err) };
  }

  const summary = aggregate(judged);
  writeSummaryJsonl(opts.runDir, summary);
  const table = formatMarkdown(summary);

  if (opts.compareRunDir === undefined) return { status: OK_STATUS, stdout: table };

  const compareSection = await buildCompareSection(parsedRaw.rows, summary, opts.compareRunDir, opts.corpusDir);
  if ("error" in compareSection) return { status: ERROR_STATUS, stdout: compareSection.error };

  return { status: OK_STATUS, stdout: `${compareSection.text}\n${table}` };
}
