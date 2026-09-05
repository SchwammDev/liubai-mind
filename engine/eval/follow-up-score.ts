import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Lang, RuleName } from "../contract.ts";
import { RULE } from "../contract.ts";
import type { CaseManifest, BehaviorCheck, RawRow, Verdict, Metrics } from "./eval-contract.ts";
import { loadCases, declaredFiles } from "./corpus.ts";
import { runBehaviorChecks } from "./behavior-checks.ts";
import type { BehaviorCheckOutcome, BehaviorCheckFailure } from "./behavior-checks.ts";
import { sourceParses } from "./parse-check.ts";
import {
  readRawJsonl,
  judgeRows,
  runScore,
  checkLang,
  metricsOf,
  entrySymbolComplexityOf,
  createdFilesOf,
  entryChangedFor,
  readTranscriptIfPresent,
  writeJudgedJsonl,
  missingSessionLogWarning,
  withWarningSuffix,
  ANSWER_KEY_PREFIXES,
  RAIL_PATH_PREFIXES,
} from "./score.ts";
import type { ContaminationCheck } from "./score.ts";
import { sourceDiffCounts } from "./diff-counts.ts";
import { classifyTranscript } from "./contamination.ts";
import type { TranscriptClassification } from "./contamination.ts";
import { buildRepetitionRecord } from "./repetition-record.ts";
import type { RepetitionRecord, StartsFrom } from "./repetition-record.ts";

export type FollowUpVerdict = "extended" | "extension-failed" | "regressed" | "broken" | "untouched" | "errored" | "timed-out";

export interface FollowUpJudgeResult {
  verdict: FollowUpVerdict;
  linesAdded: number;
  linesRemoved: number;
  before: Metrics;
  after: Metrics;
  createdFiles: string[];
  failedBehaviorChecks: BehaviorCheckFailure[];
}

export interface JudgedFollowUpRow {
  row: RawRow;
  judge: FollowUpJudgeResult;
  stratum: string;
  contaminated: boolean;
  consultedRail: boolean;
  entryUnchanged: boolean;
  entrySymbolComplexityBefore: number | null;
  entrySymbolComplexityAfter: number | null;
}

export interface FollowUpSummaryRow {
  touch: "follow-up";
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

function pristineFiles(corpusDir: string, kase: CaseManifest): Record<string, string> {
  const stripped = declaredFiles(kase);
  const files: Record<string, string> = {};
  kase.files.forEach((file, i) => {
    files[stripped[i]!] = readFileSync(join(corpusDir, kase.id, file), "utf8");
  });
  return files;
}

function filesAreIdentical(earlier: Record<string, string>, final: Record<string, string>): boolean {
  const earlierKeys = Object.keys(earlier);
  if (earlierKeys.length !== Object.keys(final).length) return false;
  return earlierKeys.every((key) => final[key] === earlier[key]);
}

function behaviorCheckOutcomeFor(kase: CaseManifest, behaviorChecks: BehaviorCheck[], entrySource: string, files: Record<string, string>): BehaviorCheckOutcome {
  return runBehaviorChecks({
    lang: checkLang(kase.lang),
    entryFilename: kase.entry,
    source: entrySource,
    entrySymbol: kase.entrySymbol,
    behaviorChecks,
    files,
    compare: "subset",
  });
}

interface FollowUpClassification {
  verdict: FollowUpVerdict;
  failedBehaviorChecks: BehaviorCheckFailure[];
}

const NO_FAILED_BEHAVIOR_CHECKS: BehaviorCheckFailure[] = [];

function classifyFollowUpRow(kase: CaseManifest, row: RawRow, earlierFiles: Record<string, string>): FollowUpClassification {
  if (row.timedOut === true) return { verdict: "timed-out", failedBehaviorChecks: NO_FAILED_BEHAVIOR_CHECKS };
  if (row.agentError !== undefined) return { verdict: "errored", failedBehaviorChecks: NO_FAILED_BEHAVIOR_CHECKS };

  const entrySource = row.files[kase.entry];
  if (entrySource === undefined || !sourceParses(entrySource, checkLang(kase.lang))) {
    return { verdict: "broken", failedBehaviorChecks: NO_FAILED_BEHAVIOR_CHECKS };
  }

  if (filesAreIdentical(earlierFiles, row.files)) return { verdict: "untouched", failedBehaviorChecks: NO_FAILED_BEHAVIOR_CHECKS };

  const originalOutcome = behaviorCheckOutcomeFor(kase, kase.behaviorChecks, entrySource, row.files);
  if (!originalOutcome.passed) return { verdict: "regressed", failedBehaviorChecks: originalOutcome.failures };

  const extensionOutcome = behaviorCheckOutcomeFor(kase, kase.extension!.behaviorChecks, entrySource, row.files);
  if (!extensionOutcome.passed) return { verdict: "extension-failed", failedBehaviorChecks: extensionOutcome.failures };

  return { verdict: "extended", failedBehaviorChecks: NO_FAILED_BEHAVIOR_CHECKS };
}

function followUpTranscriptRelativePath(row: RawRow): string {
  const info = row.followUp!;
  const suffix = info.control ? "control" : `from-repetition-${info.sourceRepetition}`;
  return join("transcripts", `${row.caseId}.${row.treatmentId}.${suffix}.jsonl`);
}

const ROW_NOT_CONTAMINATED: TranscriptClassification = { contaminated: false, consultedRail: false };

function classifyFollowUpRowContamination(row: RawRow, contamination: ContaminationCheck | undefined): TranscriptClassification {
  if (contamination === undefined) return ROW_NOT_CONTAMINATED;

  const transcript = readTranscriptIfPresent(join(contamination.runDir, followUpTranscriptRelativePath(row)));
  if (transcript === undefined) return ROW_NOT_CONTAMINATED;

  return classifyTranscript(transcript, { answerKeyPrefixes: contamination.answerKeyPrefixes, railPrefixes: contamination.railPrefixes });
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
    throw new Error(`follow-up-score: ${row.caseId}/${row.treatmentId}#${row.repetition} is not from an earlier result`);
  }
  const found = sourceRowsByKey.get(sourceRowKey(row.caseId, row.treatmentId, info.sourceRepetition));
  if (found === undefined) {
    throw new Error(`follow-up-score: source row not found for ${row.caseId}/${row.treatmentId}#${info.sourceRepetition}`);
  }
  return found;
}

function earlierFilesFor(row: RawRow, kase: CaseManifest, corpusDir: string, sourceRowsByKey: Map<string, RawRow>): Record<string, string> {
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

export async function judgeFollowUpRows(
  rows: RawRow[],
  sourceRows: RawRow[],
  corpusDir: string,
  contamination?: ContaminationCheck,
): Promise<JudgedFollowUpRow[]> {
  const cases = loadCases(corpusDir);
  if ("error" in cases) throw new Error(`follow-up-score: failed to load corpus: ${cases.error}`);

  const sourceRowsByKey = indexSourceRows(sourceRows);
  const sourceVerdictCache = new Map<string, Verdict>();

  const judged: JudgedFollowUpRow[] = [];
  for (const row of rows) {
    const kase = caseFor(cases, row.caseId);
    const earlierFiles = earlierFilesFor(row, kase, corpusDir, sourceRowsByKey);
    const classification = classifyFollowUpRow(kase, row, earlierFiles);
    const { linesAdded, linesRemoved } = sourceDiffCounts(earlierFiles, row.files, kase.lang);
    const stratum = row.followUp?.control ? CONTROL_STRATUM : await sourceVerdictOf(row, corpusDir, sourceRowsByKey, sourceVerdictCache);

    const before = await metricsOf(kase, earlierFiles);
    const after = await metricsOf(kase, row.files);
    const entrySymbolComplexityBefore = await entrySymbolComplexityOf(kase, earlierFiles[kase.entry]);
    const entrySymbolComplexityAfter = await entrySymbolComplexityOf(kase, row.files[kase.entry]);
    const filesCreated = createdFilesOf(kase, row.files);
    const { contaminated, consultedRail } = classifyFollowUpRowContamination(row, contamination);

    judged.push({
      row,
      judge: {
        verdict: classification.verdict,
        linesAdded,
        linesRemoved,
        before,
        after,
        createdFiles: filesCreated,
        failedBehaviorChecks: classification.failedBehaviorChecks,
      },
      stratum,
      contaminated,
      consultedRail,
      entryUnchanged: !entryChangedFor(earlierFiles[kase.entry]!, row.files[kase.entry]),
      entrySymbolComplexityBefore,
      entrySymbolComplexityAfter,
    });
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
    touch: "follow-up",
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

function startsFromOf(row: RawRow): StartsFrom {
  const info = row.followUp!;
  return info.control ? { kind: "original-source" } : { kind: "earlier-result", sourceRun: info.sourceRun, sourceRepetition: info.sourceRepetition! };
}

export function followUpRecordFor(runDir: string, judgedRow: JudgedFollowUpRow): RepetitionRecord {
  const { row, judge } = judgedRow;
  const relativePath = followUpTranscriptRelativePath(row);
  const sessionLog = readTranscriptIfPresent(join(runDir, relativePath));

  return buildRepetitionRecord({
    row,
    startsFrom: startsFromOf(row),
    transcriptPath: sessionLog === undefined ? null : relativePath,
    sessionLog,
    verdict: judge.verdict,
    gamedReason: null,
    failedBehaviorChecks: judge.failedBehaviorChecks,
    decisionPointsBefore: judge.before.decisionPoints,
    decisionPointsAfter: judge.after.decisionPoints,
    entrySymbolComplexityBefore: judgedRow.entrySymbolComplexityBefore,
    entrySymbolComplexityAfter: judgedRow.entrySymbolComplexityAfter,
    functionsBefore: judge.before.nFunctions,
    functionsAfter: judge.after.nFunctions,
    linesAdded: judge.linesAdded,
    linesRemoved: judge.linesRemoved,
    entryUnchanged: judgedRow.entryUnchanged,
    filesCreated: judge.createdFiles,
    contaminated: judgedRow.contaminated,
    consultedRail: judgedRow.consultedRail,
  });
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

  const contamination: ContaminationCheck = { runDir: opts.runDir, answerKeyPrefixes: ANSWER_KEY_PREFIXES, railPrefixes: RAIL_PATH_PREFIXES };

  let judged: JudgedFollowUpRow[];
  try {
    judged = await judgeFollowUpRows(parsedRaw.rows, sourceParsed.rows, opts.corpusDir, contamination);
  } catch (err) {
    return { status: 1, stdout: err instanceof Error ? err.message : String(err) };
  }

  const summary = aggregateFollowUp(judged);
  writeFollowUpSummaryJsonl(opts.runDir, summary);
  const records = judged.map((judgedRow) => followUpRecordFor(opts.runDir, judgedRow));
  writeJudgedJsonl(opts.runDir, records);
  const warning = missingSessionLogWarning(records);
  return { status: 0, stdout: withWarningSuffix(formatFollowUpMarkdown(summary), warning) };
}

export type TouchKind = { kind: "single-task" } | { kind: "follow-up"; sourceRun: string } | { error: string };

export function touchKindOf(rows: RawRow[]): TouchKind {
  const withFollowUp = rows.filter((row) => row.followUp !== undefined);
  if (withFollowUp.length === 0) return { kind: "single-task" };
  if (withFollowUp.length !== rows.length) {
    return { error: "score: run mixes single-task and follow-up rows; run follow-up scoring or single-task scoring, not both" };
  }

  const sourceRuns = new Set(withFollowUp.map((row) => row.followUp!.sourceRun));
  if (sourceRuns.size > 1) {
    return { error: `score: follow-up run mixes multiple source runs: ${[...sourceRuns].sort().join(", ")}` };
  }

  return { kind: "follow-up", sourceRun: [...sourceRuns][0]! };
}

type RunScoreOpts = Parameters<typeof runScore>[0];
type RunScoreResult = Awaited<ReturnType<typeof runScore>>;

export async function routeScore(opts: RunScoreOpts, runsRoot: string): Promise<RunScoreResult> {
  const parsedRaw = readRawJsonl(opts.runDir);
  if ("error" in parsedRaw) return { status: 1, stdout: parsedRaw.error };

  const kind = touchKindOf(parsedRaw.rows);
  if ("error" in kind) return { status: 1, stdout: kind.error };
  if (kind.kind === "single-task") return runScore(opts);

  if (opts.compareRunDir !== undefined) {
    return { status: 1, stdout: "follow-up-score: --compare is not supported for follow-up runs" };
  }

  return runFollowUpScore({ runDir: opts.runDir, corpusDir: opts.corpusDir, sourceRunDir: join(runsRoot, kind.sourceRun) });
}
