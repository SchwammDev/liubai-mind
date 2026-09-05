import type { Experiment, ExperimentKind, ExperimentStatus, ExperimentTreatment } from "./experiments.ts";
import type { GamedReason, Tier } from "./eval-contract.ts";
import type { Ending, StartsFrom } from "./repetition-record.ts";
import type { FileAtCommit } from "./provenance.ts";
import { RULE } from "../contract.ts";
import type { RuleName } from "../contract.ts";
import { buildTranscriptView } from "./session-log.ts";
import type { TranscriptView } from "./session-log.ts";

type NudgeFirings = Record<RuleName, { count: number; turns: number[] }>;

export interface JudgedRecordForReport {
  caseId: string;
  treatmentId: string;
  repetition: number;
  verdict: string;
  startsFrom: StartsFrom;
  linesAdded: number;
  linesRemoved: number;
  turns: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  nudges: NudgeFirings | null;
  decisionPointsBefore: number;
  decisionPointsAfter: number;
  functionsBefore: number;
  functionsAfter: number;
  gamedReason: GamedReason | null;
  failedBehaviorChecks: { index: number; reason: string }[];
  ending: Ending;
  transcriptPath: string | null;
  filesCreated: string[];
}

export interface RawRowForReport {
  treatmentId: string;
  provenance: { model: string; liubaiSha: string; phrasingPackHash: string | null };
  task?: string;
  delivered?: { packHash: string | null };
  caseId: string;
  repetition: number;
  files: Record<string, string>;
}

export type VerdictBarSegmentClass = "g" | "m" | "x" | "w";

export interface VerdictBarSegmentView {
  cls: VerdictBarSegmentClass;
  pct: number;
}

export interface RunRecordsForReport {
  judged: JudgedRecordForReport[];
  raw: RawRowForReport[];
}

export interface CaseFactsForReport {
  tier: Tier;
  entry: string;
  reference?: Record<string, string>;
  behaviorChecksTotal?: number;
  extensionBehaviorChecksTotal?: number;
}

export type CodeStateName = "original" | "change" | "earlier-change" | "follow-up-change";

export interface CodeStateView {
  name: CodeStateName;
  label: string;
  caption: string;
  dedupeKey: string;
  available: boolean;
  text: string;
}

export interface ReferenceFixView {
  dedupeKey: string;
  text: string;
}

export interface ReviewStateCardView {
  name: CodeStateName;
  stateNumber: number;
  title: string;
  dedupeKey: string;
  fileAtCommit?: string;
  metricLine?: string;
  verdict?: string;
  taskText?: string;
}

export interface ReviewView {
  id: string;
  verdict: string;
  whyThisVerdict: string;
  entryFilename: string;
  codeStates: CodeStateView[];
  stateCards: ReviewStateCardView[];
  defaultBeforeName: CodeStateName;
  defaultAfterName: CodeStateName;
  statsLine: string;
  nudgeSummary: string;
  filesLine: string;
  reference?: ReferenceFixView;
  transcript?: TranscriptView;
  rawTranscriptHref?: string;
  notes: string[];
  live: boolean;
}

export interface ExperimentView {
  id: string;
  name: string;
  kindLabel: string;
  question: string;
  treatmentIds: string[];
  model: string;
  tierLabel: string;
  size: string;
  status: ExperimentStatus;
  outcome: string;
  identicalTreatmentsFlag: boolean;
}

export interface MilestoneView {
  milestone: string;
  experiments: ExperimentView[];
}

export interface RepetitionView {
  id: string;
  caseId: string;
  repetition: number;
  verdict: string;
  startsFromLabel: string;
  linesAddedRemoved: string;
  turns: string;
  tokensIn: string;
  nudges: string;
  nudged: boolean;
  detail: string;
  review?: ReviewView;
}

export interface TreatmentView {
  treatmentId: string;
  run: string;
  verdictDistribution: string;
  verdictBarSegments: VerdictBarSegmentView[];
  meanTurns: string;
  meanTokensIn: string;
  meanNudgesPerRepetition: string;
  repetitions: RepetitionView[];
}

export interface PerCaseCellView {
  label: string;
  barSegments: VerdictBarSegmentView[];
}

export interface PerCaseRowView {
  caseId: string;
  cells: PerCaseCellView[];
  wherePart: string;
}

export interface SetupCheckView {
  summary: string;
  identicalTreatments: boolean;
}

export interface ExperimentDetailView {
  id: string;
  name: string;
  kindLabel: string;
  tierLabel: string;
  question: string;
  outcome: string;
  treatmentIds: string[];
  controlTreatmentId: string;
  successVerdict: string;
  setupCheck: SetupCheckView;
  treatments: TreatmentView[];
  perCase: PerCaseRowView[];
}

export interface ReportViewModel {
  milestones: MilestoneView[];
  unclaimedRunFolders: string[];
  experimentDetails: ExperimentDetailView[];
}

const KIND_LABELS: Record<ExperimentKind, string> = {
  "single-task": "single task",
  "with-follow-up-tasks": "with follow-up tasks",
};

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function distinctSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function judgedRecordsFor(runData: Map<string, RunRecordsForReport>, run: string, treatmentId: string): JudgedRecordForReport[] {
  return (runData.get(run)?.judged ?? []).filter((record) => record.treatmentId === treatmentId);
}

function rawRowsFor(runData: Map<string, RunRecordsForReport>, run: string, treatmentId: string): RawRowForReport[] {
  return (runData.get(run)?.raw ?? []).filter((row) => row.treatmentId === treatmentId);
}

function modelLabelOf(rows: RawRowForReport[]): string {
  return distinctSorted(rows.map((row) => row.provenance.model)).join(", ");
}

function tierLabelOf(caseIds: string[], caseFactsByCaseId: Map<string, CaseFactsForReport>): string {
  const tiers = distinctSorted(
    caseIds.map((caseId) => caseFactsByCaseId.get(caseId)?.tier).filter((tier): tier is Tier => tier !== undefined),
  );
  return tiers.map((tier) => `${tier} cases`).join(", ");
}

function repetitionCountsByTreatmentAndCase(records: JudgedRecordForReport[]): number[] {
  const repetitionsSeen = new Map<string, Set<number>>();

  for (const record of records) {
    const key = `${record.treatmentId}\0${record.caseId}`;
    const seen = repetitionsSeen.get(key) ?? new Set<number>();
    seen.add(record.repetition);
    repetitionsSeen.set(key, seen);
  }

  return [...repetitionsSeen.values()].map((seen) => seen.size);
}

function sizeLabelOf(records: JudgedRecordForReport[]): string {
  const caseCount = new Set(records.map((record) => record.caseId)).size;
  const repetitionCounts = repetitionCountsByTreatmentAndCase(records);
  const repetitions = repetitionCounts.length === 0 ? 0 : Math.max(...repetitionCounts);
  return `${pluralize(caseCount, "case")} × ${pluralize(repetitions, "repetition")} per treatment`;
}

function allJudgedRecordsFor(experiment: Experiment, runData: Map<string, RunRecordsForReport>): JudgedRecordForReport[] {
  return experiment.treatments.flatMap((treatment) => judgedRecordsFor(runData, treatment.run, treatment.treatmentId));
}

function allRawRowsFor(experiment: Experiment, runData: Map<string, RunRecordsForReport>): RawRowForReport[] {
  return experiment.treatments.flatMap((treatment) => rawRowsFor(runData, treatment.run, treatment.treatmentId));
}

function experimentViewOf(
  experiment: Experiment,
  runData: Map<string, RunRecordsForReport>,
  caseFactsByCaseId: Map<string, CaseFactsForReport>,
  identicalTreatmentsFlag: boolean,
): ExperimentView {
  const records = allJudgedRecordsFor(experiment, runData);
  const rawRows = allRawRowsFor(experiment, runData);

  return {
    id: experiment.id,
    name: experiment.name,
    kindLabel: KIND_LABELS[experiment.kind],
    question: experiment.question,
    treatmentIds: experiment.treatments.map((treatment) => treatment.treatmentId),
    model: modelLabelOf(rawRows),
    tierLabel: tierLabelOf(records.map((record) => record.caseId), caseFactsByCaseId),
    size: sizeLabelOf(records),
    status: experiment.status,
    outcome: experiment.outcome,
    identicalTreatmentsFlag,
  };
}

const SINGLE_TASK_SEVERITY: readonly string[] = ["broken", "behavior-broken", "gamed", "bar-missed", "timed-out", "errored", "untouched", "genuine-fix"];
const FOLLOW_UP_SEVERITY: readonly string[] = ["regressed", "broken", "extension-failed", "timed-out", "errored", "untouched", "extended"];

function severityOrderFor(kind: ExperimentKind): readonly string[] {
  return kind === "single-task" ? SINGLE_TASK_SEVERITY : FOLLOW_UP_SEVERITY;
}

function successVerdictFor(kind: ExperimentKind): string {
  return kind === "single-task" ? "genuine-fix" : "extended";
}

function severityRank(order: readonly string[], verdict: string): number {
  const index = order.indexOf(verdict);
  return index === -1 ? order.length : index;
}

interface RepetitionFacts {
  run: string;
  caseId: string;
  treatmentId: string;
  repetition: number;
  verdict: string;
  startsFrom: StartsFrom;
  linesAdded: number;
  linesRemoved: number;
  turns: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  nudges: NudgeFirings | null;
  nudgesTotal: number | null;
  nudgeTurns: number[];
  decisionPointsBefore: number;
  decisionPointsAfter: number;
  functionsBefore: number;
  functionsAfter: number;
  gamedReason: GamedReason | null;
  failedBehaviorChecks: { index: number; reason: string }[];
  ending: Ending;
  transcriptPath: string | null;
  filesCreated: string[];
}

function repetitionIdFor(facts: { run: string; caseId: string; treatmentId: string; repetition: number }): string {
  return `${facts.run}/${facts.caseId}/${facts.treatmentId}/${facts.repetition}`;
}

function nudgeSummaryOf(nudges: NudgeFirings | null): { total: number | null; turns: number[] } {
  if (nudges === null) return { total: null, turns: [] };

  let total = 0;
  const turns = new Set<number>();
  for (const firing of Object.values(nudges)) {
    total += firing.count;
    for (const turn of firing.turns) turns.add(turn);
  }
  return { total, turns: [...turns].sort((a, b) => a - b) };
}

function repetitionFactsFor(run: string, records: JudgedRecordForReport[]): RepetitionFacts[] {
  return records.map((record) => {
    const { total, turns } = nudgeSummaryOf(record.nudges);
    return {
      run,
      caseId: record.caseId,
      treatmentId: record.treatmentId,
      repetition: record.repetition,
      verdict: record.verdict,
      startsFrom: record.startsFrom,
      linesAdded: record.linesAdded,
      linesRemoved: record.linesRemoved,
      turns: record.turns,
      tokensIn: record.tokensIn,
      tokensOut: record.tokensOut,
      durationMs: record.durationMs,
      nudges: record.nudges,
      nudgesTotal: total,
      nudgeTurns: turns,
      decisionPointsBefore: record.decisionPointsBefore,
      decisionPointsAfter: record.decisionPointsAfter,
      functionsBefore: record.functionsBefore,
      functionsAfter: record.functionsAfter,
      gamedReason: record.gamedReason,
      failedBehaviorChecks: record.failedBehaviorChecks,
      ending: record.ending,
      transcriptPath: record.transcriptPath,
      filesCreated: record.filesCreated,
    };
  });
}

function sortWorstFirst(order: readonly string[], facts: RepetitionFacts[]): RepetitionFacts[] {
  const byCaseAndRepetition = [...facts].sort((a, b) => (a.caseId === b.caseId ? a.repetition - b.repetition : a.caseId.localeCompare(b.caseId)));
  return byCaseAndRepetition.sort((a, b) => severityRank(order, a.verdict) - severityRank(order, b.verdict));
}

function functionsDeltaFact(facts: RepetitionFacts): string | undefined {
  const delta = facts.functionsAfter - facts.functionsBefore;
  if (delta === 0) return undefined;
  return delta > 0 ? `${delta} functions added` : `${-delta} functions removed`;
}

function failedChecksFact(facts: RepetitionFacts): string | undefined {
  if (facts.failedBehaviorChecks.length === 0) return undefined;
  return `check failed: ${facts.failedBehaviorChecks.map((check) => check.reason).join(", ")}`;
}

function nudgeTurnsFact(facts: RepetitionFacts): string | undefined {
  if (facts.nudgeTurns.length === 0) return undefined;
  return `nudges at turns ${facts.nudgeTurns.join(", ")}`;
}

export function humanizeGamedReason(reason: GamedReason): string {
  return reason.replace(/-/g, " ");
}

function gamedReasonFact(facts: RepetitionFacts): string | undefined {
  return facts.gamedReason === null ? undefined : humanizeGamedReason(facts.gamedReason);
}

function detailFactsFor(facts: RepetitionFacts): string[] {
  return [gamedReasonFact(facts), failedChecksFact(facts), functionsDeltaFact(facts), nudgeTurnsFact(facts)].filter(
    (fact): fact is string => fact !== undefined,
  );
}

function partingExtraFact(facts: RepetitionFacts): string | undefined {
  return gamedReasonFact(facts) ?? facts.failedBehaviorChecks[0]?.reason ?? functionsDeltaFact(facts) ?? nudgeTurnsFact(facts);
}

function isAbnormalEnding(facts: RepetitionFacts): boolean {
  return facts.ending === "timed-out" || facts.ending === "errored";
}

function startsFromLabelOf(startsFrom: StartsFrom): string {
  return startsFrom.kind === "original-source" ? "original source" : `earlier result, repetition ${startsFrom.sourceRepetition}`;
}

function rawRowAt(runData: Map<string, RunRecordsForReport>, run: string, caseId: string, treatmentId: string, repetition: number): RawRowForReport | undefined {
  return runData.get(run)?.raw.find((row) => row.caseId === caseId && row.treatmentId === treatmentId && row.repetition === repetition);
}

function judgedRecordAt(
  runData: Map<string, RunRecordsForReport>,
  run: string,
  caseId: string,
  treatmentId: string,
  repetition: number,
): JudgedRecordForReport | undefined {
  return runData.get(run)?.judged.find((record) => record.caseId === caseId && record.treatmentId === treatmentId && record.repetition === repetition);
}

function ownFilesCodeState(
  name: Exclude<CodeStateName, "original">,
  label: string,
  row: RawRowForReport | undefined,
  entry: string,
  caption: string,
  dedupeKey: string,
): CodeStateView {
  const text = row?.files[entry];
  return { name, label, caption, dedupeKey, available: text !== undefined, text: text ?? "no recorded files for this repetition" };
}

function originalCodeState(caseId: string, sha: string, entry: string, originalSourceByKey: Map<string, FileAtCommit>): CodeStateView {
  const resolved = originalSourceByKey.get(`${caseId}\0${sha}`);
  const available = resolved !== undefined && "content" in resolved;
  return {
    name: "original",
    label: "original source",
    caption: `${entry} at commit ${sha}`,
    dedupeKey: `original\0${caseId}\0${sha}`,
    available,
    text: available ? (resolved as { content: string }).content : `the source at commit ${sha} is unavailable`,
  };
}

function changeCaptionFor(facts: RepetitionFacts): string {
  return `run folder ${facts.run}, repetition ${facts.repetition}`;
}

function changeDedupeKeyFor(name: Extract<CodeStateName, "change" | "follow-up-change">, facts: RepetitionFacts): string {
  return [name, facts.run, facts.caseId, facts.treatmentId, facts.repetition].join("\0");
}

const TASK_TRUNCATE_LENGTH = 60;

function truncateTask(text: string): string {
  const oneLine = text.split("\n")[0]!.trim();
  return oneLine.length <= TASK_TRUNCATE_LENGTH ? oneLine : `${oneLine.slice(0, TASK_TRUNCATE_LENGTH).trimEnd()}…`;
}

function taskTextFor(row: RawRowForReport | undefined): string | undefined {
  return row?.task === undefined ? undefined : truncateTask(row.task);
}

function complexityLine(before: number, after: number): string {
  return `complexity ${before} → ${after}`;
}

const CHECKS_NOT_RUN_VERDICTS = new Set(["broken", "untouched", "timed-out", "errored"]);

interface ChecksSource {
  verdict: string;
  failedBehaviorChecks: { index: number; reason: string }[];
}

function checksSuffixFor(total: number | undefined, source: ChecksSource): string {
  if (total === undefined || total === 0) return "";
  if (CHECKS_NOT_RUN_VERDICTS.has(source.verdict)) return "";
  return ` · behavior checks ${total - source.failedBehaviorChecks.length} of ${total}`;
}

function changeMetricLineFor(total: number | undefined, source: ChecksSource & { decisionPointsBefore: number; decisionPointsAfter: number }): string {
  return `${complexityLine(source.decisionPointsBefore, source.decisionPointsAfter)}${checksSuffixFor(total, source)}`;
}

function originalCard(dedupeKey: string, fileAtCommit: string, complexityBefore: number): ReviewStateCardView {
  return { name: "original", stateNumber: 0, title: "state 0 · original source", dedupeKey, fileAtCommit, metricLine: `complexity ${complexityBefore}` };
}

function changeCardFor(
  name: Exclude<CodeStateName, "original">,
  stateNumber: number,
  title: string,
  dedupeKey: string,
  checksTotal: number | undefined,
  source: ChecksSource & { decisionPointsBefore: number; decisionPointsAfter: number },
  row: RawRowForReport | undefined,
): ReviewStateCardView {
  const taskText = taskTextFor(row);
  return {
    name,
    stateNumber,
    title,
    dedupeKey,
    verdict: source.verdict,
    metricLine: changeMetricLineFor(checksTotal, source),
    ...(taskText !== undefined ? { taskText } : {}),
  };
}

function codeStatesForOriginalSource(
  kind: ExperimentKind,
  facts: RepetitionFacts,
  caseFacts: CaseFactsForReport,
  ownRow: RawRowForReport | undefined,
  originalSourceByKey: Map<string, FileAtCommit>,
): { codeStates: CodeStateView[]; cards: ReviewStateCardView[] } {
  const entry = caseFacts.entry;
  const sha = ownRow?.provenance.liubaiSha ?? "unknown";
  const original = originalCodeState(facts.caseId, sha, entry, originalSourceByKey);
  const change = ownFilesCodeState("change", "change", ownRow, entry, changeCaptionFor(facts), changeDedupeKeyFor("change", facts));
  const checksTotal = kind === "single-task" ? caseFacts.behaviorChecksTotal : caseFacts.extensionBehaviorChecksTotal;

  return {
    codeStates: [original, change],
    cards: [
      originalCard(original.dedupeKey, original.caption, facts.decisionPointsBefore),
      changeCardFor("change", 1, "state 1 · change · this repetition", change.dedupeKey, checksTotal, facts, ownRow),
    ],
  };
}

function codeStatesForEarlierResult(
  facts: RepetitionFacts,
  startsFrom: Extract<StartsFrom, { kind: "earlier-result" }>,
  caseFacts: CaseFactsForReport,
  runData: Map<string, RunRecordsForReport>,
  ownRow: RawRowForReport | undefined,
  originalSourceByKey: Map<string, FileAtCommit>,
): { codeStates: CodeStateView[]; cards: ReviewStateCardView[] } {
  const entry = caseFacts.entry;
  const sourceRow = rawRowAt(runData, startsFrom.sourceRun, facts.caseId, facts.treatmentId, startsFrom.sourceRepetition);
  const sourceRecord = judgedRecordAt(runData, startsFrom.sourceRun, facts.caseId, facts.treatmentId, startsFrom.sourceRepetition);
  const sha = sourceRow?.provenance.liubaiSha ?? "unknown";
  const earlierCaption = `run folder ${startsFrom.sourceRun}, repetition ${startsFrom.sourceRepetition}`;
  const earlierDedupeKey = ["earlier-change", startsFrom.sourceRun, facts.caseId, facts.treatmentId, startsFrom.sourceRepetition].join("\0");

  const original = originalCodeState(facts.caseId, sha, entry, originalSourceByKey);
  const earlierChange = ownFilesCodeState("earlier-change", "earlier change", sourceRow, entry, earlierCaption, earlierDedupeKey);
  const followUpChange = ownFilesCodeState("follow-up-change", "follow-up change", ownRow, entry, changeCaptionFor(facts), changeDedupeKeyFor("follow-up-change", facts));

  const earlierTitle = `state 1 · earlier change · run folder ${startsFrom.sourceRun}, repetition ${startsFrom.sourceRepetition}`;
  const cards: ReviewStateCardView[] = [originalCard(original.dedupeKey, original.caption, facts.decisionPointsBefore)];
  if (sourceRecord !== undefined) {
    cards.push(changeCardFor("earlier-change", 1, earlierTitle, earlierChange.dedupeKey, caseFacts.behaviorChecksTotal, sourceRecord, sourceRow));
  }
  cards.push(
    changeCardFor(
      "follow-up-change",
      2,
      "state 2 · follow-up change · this repetition",
      followUpChange.dedupeKey,
      caseFacts.extensionBehaviorChecksTotal,
      facts,
      ownRow,
    ),
  );

  return { codeStates: [original, earlierChange, followUpChange], cards };
}

function defaultPairFor(startsFrom: StartsFrom): { before: CodeStateName; after: CodeStateName } {
  return startsFrom.kind === "original-source" ? { before: "original", after: "change" } : { before: "earlier-change", after: "follow-up-change" };
}

function whyThisVerdictText(facts: RepetitionFacts): string {
  const parts = [
    `verdict ${facts.verdict}`,
    `decision points ${facts.decisionPointsBefore} → ${facts.decisionPointsAfter}`,
    `functions ${facts.functionsBefore} → ${facts.functionsAfter}`,
  ];
  if (facts.failedBehaviorChecks.length > 0) {
    parts.push(`failing checks: ${facts.failedBehaviorChecks.map((check) => check.reason).join(", ")}`);
  }
  if (facts.gamedReason !== null) parts.push(humanizeGamedReason(facts.gamedReason));
  return parts.join(" · ");
}

function referenceFixFor(caseId: string, caseFacts: CaseFactsForReport): ReferenceFixView | undefined {
  const text = caseFacts.reference?.[caseFacts.entry];
  if (text === undefined) return undefined;
  return { dedupeKey: `reference\0${caseId}`, text };
}

function transcriptFieldsFor(facts: RepetitionFacts, sessionLogByKey: Map<string, string>): Pick<ReviewView, "transcript" | "rawTranscriptHref"> {
  const log = sessionLogByKey.get(repetitionIdFor(facts));
  const transcript = log === undefined ? undefined : buildTranscriptView(log);
  const rawTranscriptHref = facts.transcriptPath === null ? undefined : `${facts.run}/${facts.transcriptPath}`;

  return {
    ...(transcript !== undefined ? { transcript } : {}),
    ...(rawTranscriptHref !== undefined ? { rawTranscriptHref } : {}),
  };
}

function formatTokensK(value: number | null): string | undefined {
  return value === null ? undefined : `${Math.round(value / 1000)} k`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

function statsLineFor(facts: RepetitionFacts): string {
  const tokensIn = formatTokensK(facts.tokensIn);
  const tokensOut = formatTokensK(facts.tokensOut);

  return [
    `+${facts.linesAdded} / −${facts.linesRemoved} lines`,
    facts.turns === null ? undefined : `${facts.turns} turns`,
    tokensIn === undefined ? undefined : `${tokensIn} input tokens`,
    tokensOut === undefined ? undefined : `${tokensOut} output tokens`,
    formatDuration(facts.durationMs),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

const NUDGE_RULE_LABELS: Record<RuleName, string> = {
  [RULE.cc]: "complexity",
  [RULE.ccDelta]: "complexity",
  [RULE.typeAnnotation]: "type annotation",
  [RULE.testLinearity]: "test linearity",
  [RULE.testAssertPile]: "test assert pile",
  [RULE.testDataPlumbing]: "test data plumbing",
  [RULE.discourageComments]: "discourage comments",
};

function nudgeSummaryFor(facts: RepetitionFacts): string {
  if (facts.nudges === null) return "";
  return Object.entries(facts.nudges)
    .filter(([, firing]) => firing.count > 0)
    .map(([rule, firing]) => `${NUDGE_RULE_LABELS[rule as RuleName]} nudge ×${firing.count}`)
    .join(" · ");
}

function filesLineFor(ownRow: RawRowForReport | undefined, filesCreated: string[]): string {
  if (ownRow === undefined) return "";
  const created = new Set(filesCreated);
  const entries = Object.keys(ownRow.files).map((file) => `${file} (${created.has(file) ? "created" : "modified"})`);
  return entries.length === 0 ? "" : `files: ${entries.join(" · ")}`;
}

function reviewViewFor(
  kind: ExperimentKind,
  facts: RepetitionFacts,
  caseFactsByCaseId: Map<string, CaseFactsForReport>,
  runData: Map<string, RunRecordsForReport>,
  originalSourceByKey: Map<string, FileAtCommit>,
  sessionLogByKey: Map<string, string>,
  notesByKey: Map<string, string[]>,
  live: boolean,
): ReviewView | undefined {
  const caseFacts = caseFactsByCaseId.get(facts.caseId);
  if (caseFacts === undefined) return undefined;

  const ownRow = rawRowAt(runData, facts.run, facts.caseId, facts.treatmentId, facts.repetition);
  const { codeStates, cards } =
    facts.startsFrom.kind === "original-source"
      ? codeStatesForOriginalSource(kind, facts, caseFacts, ownRow, originalSourceByKey)
      : codeStatesForEarlierResult(facts, facts.startsFrom, caseFacts, runData, ownRow, originalSourceByKey);
  const reference = referenceFixFor(facts.caseId, caseFacts);
  const defaultPair = defaultPairFor(facts.startsFrom);
  const id = repetitionIdFor(facts);

  return {
    id,
    verdict: facts.verdict,
    whyThisVerdict: whyThisVerdictText(facts),
    entryFilename: caseFacts.entry,
    codeStates,
    stateCards: cards,
    defaultBeforeName: defaultPair.before,
    defaultAfterName: defaultPair.after,
    statsLine: statsLineFor(facts),
    nudgeSummary: nudgeSummaryFor(facts),
    filesLine: filesLineFor(ownRow, facts.filesCreated),
    notes: notesByKey.get(id) ?? [],
    live,
    ...(reference !== undefined ? { reference } : {}),
    ...transcriptFieldsFor(facts, sessionLogByKey),
  };
}

function repetitionViewOf(
  kind: ExperimentKind,
  facts: RepetitionFacts,
  caseFactsByCaseId: Map<string, CaseFactsForReport>,
  runData: Map<string, RunRecordsForReport>,
  originalSourceByKey: Map<string, FileAtCommit>,
  sessionLogByKey: Map<string, string>,
  notesByKey: Map<string, string[]>,
  live: boolean,
): RepetitionView {
  const review = reviewViewFor(kind, facts, caseFactsByCaseId, runData, originalSourceByKey, sessionLogByKey, notesByKey, live);

  return {
    id: repetitionIdFor(facts),
    caseId: facts.caseId,
    repetition: facts.repetition,
    verdict: facts.verdict,
    startsFromLabel: startsFromLabelOf(facts.startsFrom),
    linesAddedRemoved: `+${facts.linesAdded} / -${facts.linesRemoved}`,
    turns: facts.turns === null ? "-" : String(facts.turns),
    tokensIn: facts.tokensIn === null ? "-" : String(facts.tokensIn),
    nudges: facts.nudgesTotal === null || facts.nudgesTotal === 0 ? "-" : String(facts.nudgesTotal),
    nudged: facts.nudgesTotal !== null && facts.nudgesTotal > 0,
    detail: detailFactsFor(facts).join(" · "),
    ...(review !== undefined ? { review } : {}),
  };
}

function distributionCounts(order: readonly string[], facts: RepetitionFacts[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const fact of facts) counts.set(fact.verdict, (counts.get(fact.verdict) ?? 0) + 1);
  return order.filter((verdict) => (counts.get(verdict) ?? 0) > 0).map((verdict) => [verdict, counts.get(verdict)!]);
}

function distributionLabel(order: readonly string[], facts: RepetitionFacts[]): string {
  return distributionCounts(order, facts)
    .map(([verdict, count]) => `${verdict} ${count}`)
    .join(" · ");
}

function distributionKey(order: readonly string[], facts: RepetitionFacts[]): string {
  return distributionCounts(order, facts)
    .map(([verdict, count]) => `${verdict}:${count}`)
    .join(",");
}

const SINGLE_TASK_SEGMENT_CLASS: Record<string, VerdictBarSegmentClass> = {
  "genuine-fix": "g",
  gamed: "m",
  "bar-missed": "m",
  broken: "x",
  "behavior-broken": "x",
  untouched: "w",
  errored: "w",
  "timed-out": "w",
};

const FOLLOW_UP_SEGMENT_CLASS: Record<string, VerdictBarSegmentClass> = {
  extended: "g",
  "extension-failed": "m",
  regressed: "x",
  broken: "x",
  untouched: "w",
  errored: "w",
  "timed-out": "w",
};

function segmentClassFor(kind: ExperimentKind, verdict: string): VerdictBarSegmentClass {
  const table = kind === "single-task" ? SINGLE_TASK_SEGMENT_CLASS : FOLLOW_UP_SEGMENT_CLASS;
  return table[verdict] ?? "w";
}

const SEGMENT_ORDER: readonly VerdictBarSegmentClass[] = ["g", "m", "x", "w"];

function barSegmentsFor(kind: ExperimentKind, facts: RepetitionFacts[]): VerdictBarSegmentView[] {
  if (facts.length === 0) return [];

  const counts = new Map<VerdictBarSegmentClass, number>();
  for (const fact of facts) counts.set(segmentClassFor(kind, fact.verdict), (counts.get(segmentClassFor(kind, fact.verdict)) ?? 0) + 1);

  return SEGMENT_ORDER.filter((cls) => (counts.get(cls) ?? 0) > 0).map((cls) => ({
    cls,
    pct: Math.round(((counts.get(cls) ?? 0) / facts.length) * 100),
  }));
}

function meanOfDefined(values: (number | null)[]): number | null {
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length === 0) return null;
  return defined.reduce((sum, value) => sum + value, 0) / defined.length;
}

function formatMean(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function treatmentViewOf(
  kind: ExperimentKind,
  order: readonly string[],
  treatment: ExperimentTreatment,
  facts: RepetitionFacts[],
  caseFactsByCaseId: Map<string, CaseFactsForReport>,
  runData: Map<string, RunRecordsForReport>,
  originalSourceByKey: Map<string, FileAtCommit>,
  sessionLogByKey: Map<string, string>,
  notesByKey: Map<string, string[]>,
  live: boolean,
): TreatmentView {
  return {
    treatmentId: treatment.treatmentId,
    run: treatment.run,
    verdictDistribution: distributionLabel(order, facts),
    verdictBarSegments: barSegmentsFor(kind, facts),
    meanTurns: formatMean(meanOfDefined(facts.map((fact) => fact.turns))),
    meanTokensIn: formatMean(meanOfDefined(facts.map((fact) => fact.tokensIn))),
    meanNudgesPerRepetition: formatMean(meanOfDefined(facts.map((fact) => fact.nudgesTotal))),
    repetitions: facts.map((fact) => repetitionViewOf(kind, fact, caseFactsByCaseId, runData, originalSourceByKey, sessionLogByKey, notesByKey, live)),
  };
}

function wherePartChainFor(facts: RepetitionFacts): string {
  const extra = partingExtraFact(facts);
  const parts = [facts.treatmentId, `repetition ${facts.repetition}`, facts.verdict];
  return extra === undefined ? parts.join(" · ") : [...parts, extra].join(" · ");
}

interface TreatmentCaseFacts {
  treatmentId: string;
  facts: RepetitionFacts[];
}

function wherePartFactsFor(successVerdict: string, perTreatment: TreatmentCaseFacts[]): string[] {
  const chains: string[] = [];
  for (const treatment of perTreatment) {
    const worst = treatment.facts[0];
    if (worst === undefined) continue;
    if (worst.verdict === successVerdict && !isAbnormalEnding(worst)) continue;
    chains.push(wherePartChainFor(worst));
  }
  return chains;
}

function perCaseRowsFor(kind: ExperimentKind, order: readonly string[], successVerdict: string, treatments: TreatmentCaseFacts[]): PerCaseRowView[] {
  const caseIds = distinctSorted(treatments.flatMap((treatment) => treatment.facts.map((fact) => fact.caseId)));

  return caseIds.map((caseId) => {
    const perTreatment = treatments.map((treatment) => ({ treatmentId: treatment.treatmentId, facts: treatment.facts.filter((fact) => fact.caseId === caseId) }));
    const keys = perTreatment.map((treatment) => distributionKey(order, treatment.facts));
    const allMatch = keys.every((key) => key === keys[0]);
    const anyAbnormal = perTreatment.some((treatment) => treatment.facts.some(isAbnormalEnding));

    return {
      caseId,
      cells: perTreatment.map((treatment) => ({
        label: distributionLabel(order, treatment.facts),
        barSegments: barSegmentsFor(kind, treatment.facts),
      })),
      wherePart: allMatch && !anyAbnormal ? "" : wherePartFactsFor(successVerdict, perTreatment).join("; "),
    };
  });
}

interface TreatmentProvenanceFacts {
  treatmentId: string;
  liubaiShas: string[];
  models: string[];
  phrasingPackHashes: string[];
  deliveredTexts: string[];
  hasEvidence: boolean;
}

function phrasingPackLabel(hash: string | null): string {
  return hash === null ? "none" : hash;
}

function provenanceFactsFor(treatmentId: string, rows: RawRowForReport[]): TreatmentProvenanceFacts {
  return {
    treatmentId,
    liubaiShas: distinctSorted(rows.map((row) => row.provenance.liubaiSha)),
    models: distinctSorted(rows.map((row) => row.provenance.model)),
    phrasingPackHashes: distinctSorted(rows.map((row) => phrasingPackLabel(row.provenance.phrasingPackHash))),
    deliveredTexts: distinctSorted(rows.filter((row) => row.task !== undefined).map((row) => row.task!)),
    hasEvidence: rows.some((row) => row.task !== undefined || row.delivered !== undefined),
  };
}

const UNVERIFIABLE_SETUP_MESSAGE = "no row in this run carries a delivery stamp or task text; setup is unverifiable (the run predates stamping)";

function valuesEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function compareField(label: string, valueSetsPerTreatment: string[][]): string | undefined {
  const withEvidence = valueSetsPerTreatment.filter((values) => values.length > 0);
  if (withEvidence.length < 2) return undefined;

  const [first, ...rest] = withEvidence;
  if (rest.every((values) => valuesEqual(values, first!))) return `same ${label}: ${first!.join(", ")}`;

  return `${label} differs: ${withEvidence.map((values) => values.join(", ")).join(" vs ")}`;
}

function hasIdenticalDeliveredText(perTreatment: TreatmentProvenanceFacts[]): boolean {
  for (let i = 0; i < perTreatment.length; i++) {
    for (let j = i + 1; j < perTreatment.length; j++) {
      if (perTreatment[i]!.deliveredTexts.some((text) => perTreatment[j]!.deliveredTexts.includes(text))) return true;
    }
  }
  return false;
}

function deliveredTextDiffersFact(perTreatment: TreatmentProvenanceFacts[], identicalTreatments: boolean): string | undefined {
  if (identicalTreatments) return undefined;
  const withDeliveredText = perTreatment.filter((facts) => facts.deliveredTexts.length > 0);
  return withDeliveredText.length < 2 ? undefined : "delivered text differs";
}

function partialEvidenceMessage(perTreatment: TreatmentProvenanceFacts[]): string {
  const withEvidence = perTreatment.filter((facts) => facts.hasEvidence).map((facts) => facts.treatmentId);
  const withoutEvidence = perTreatment.filter((facts) => !facts.hasEvidence).map((facts) => facts.treatmentId);
  return `${withEvidence.join(", ")} carries a delivery stamp or task text; ${withoutEvidence.join(", ")} carries none`;
}

function setupCheckFor(experiment: Experiment, runData: Map<string, RunRecordsForReport>): SetupCheckView {
  const perTreatment = experiment.treatments.map((treatment) =>
    provenanceFactsFor(treatment.treatmentId, rawRowsFor(runData, treatment.run, treatment.treatmentId)),
  );

  if (!perTreatment.some((facts) => facts.hasEvidence)) {
    return { summary: UNVERIFIABLE_SETUP_MESSAGE, identicalTreatments: false };
  }

  const identicalTreatments = hasIdenticalDeliveredText(perTreatment);

  const lines = [
    compareField("liubai commit", perTreatment.map((facts) => facts.liubaiShas)),
    compareField("model", perTreatment.map((facts) => facts.models)),
    compareField("wording pack", perTreatment.map((facts) => facts.phrasingPackHashes)),
    deliveredTextDiffersFact(perTreatment, identicalTreatments),
  ].filter((line): line is string => line !== undefined);

  if (identicalTreatments) lines.push("identical treatments: delivered text is byte-identical across at least two treatments");

  const summary = lines.length > 0 ? lines.join(" · ") : partialEvidenceMessage(perTreatment);

  return { summary, identicalTreatments };
}

function experimentDetailFor(
  experiment: Experiment,
  runData: Map<string, RunRecordsForReport>,
  caseFactsByCaseId: Map<string, CaseFactsForReport>,
  originalSourceByKey: Map<string, FileAtCommit>,
  sessionLogByKey: Map<string, string>,
  notesByKey: Map<string, string[]>,
  live: boolean,
): ExperimentDetailView {
  const order = severityOrderFor(experiment.kind);
  const successVerdict = successVerdictFor(experiment.kind);

  const treatmentsWithFacts = experiment.treatments.map((treatment) => ({
    treatment,
    facts: sortWorstFirst(order, repetitionFactsFor(treatment.run, judgedRecordsFor(runData, treatment.run, treatment.treatmentId))),
  }));

  return {
    id: experiment.id,
    name: experiment.name,
    kindLabel: KIND_LABELS[experiment.kind],
    tierLabel: tierLabelOf(treatmentsWithFacts.flatMap(({ facts }) => facts.map((fact) => fact.caseId)), caseFactsByCaseId),
    question: experiment.question,
    outcome: experiment.outcome,
    treatmentIds: experiment.treatments.map((treatment) => treatment.treatmentId),
    controlTreatmentId: experiment.controlTreatment,
    successVerdict,
    setupCheck: setupCheckFor(experiment, runData),
    treatments: treatmentsWithFacts.map(({ treatment, facts }) =>
      treatmentViewOf(experiment.kind, order, treatment, facts, caseFactsByCaseId, runData, originalSourceByKey, sessionLogByKey, notesByKey, live),
    ),
    perCase: perCaseRowsFor(
      experiment.kind,
      order,
      successVerdict,
      treatmentsWithFacts.map(({ treatment, facts }) => ({ treatmentId: treatment.treatmentId, facts })),
    ),
  };
}

interface MilestoneGroup {
  milestone: string;
  experiments: Experiment[];
}

function groupByMilestone(experiments: Experiment[]): MilestoneGroup[] {
  const order: string[] = [];
  const byMilestone = new Map<string, Experiment[]>();

  for (const experiment of experiments) {
    const bucket = byMilestone.get(experiment.milestone);
    if (bucket === undefined) {
      byMilestone.set(experiment.milestone, [experiment]);
      order.push(experiment.milestone);
    } else {
      bucket.push(experiment);
    }
  }

  return order.map((milestone) => ({ milestone, experiments: byMilestone.get(milestone)! }));
}

export function buildReportViewModel(
  experiments: Experiment[],
  runData: Map<string, RunRecordsForReport>,
  caseFactsByCaseId: Map<string, CaseFactsForReport>,
  unclaimedRunFolders: string[],
  originalSourceByKey: Map<string, FileAtCommit> = new Map(),
  sessionLogByKey: Map<string, string> = new Map(),
  notesByKey: Map<string, string[]> = new Map(),
  live = false,
): ReportViewModel {
  const experimentDetails = experiments.map((experiment) =>
    experimentDetailFor(experiment, runData, caseFactsByCaseId, originalSourceByKey, sessionLogByKey, notesByKey, live),
  );
  const identicalTreatmentsFlagById = new Map(experimentDetails.map((detail) => [detail.id, detail.setupCheck.identicalTreatments]));

  const milestones = groupByMilestone(experiments).map((group) => ({
    milestone: group.milestone,
    experiments: group.experiments.map((experiment) =>
      experimentViewOf(experiment, runData, caseFactsByCaseId, identicalTreatmentsFlagById.get(experiment.id) ?? false),
    ),
  }));

  return { milestones, unclaimedRunFolders: [...unclaimedRunFolders].sort(), experimentDetails };
}
