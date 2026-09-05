import type { Experiment, ExperimentKind, ExperimentStatus, ExperimentTreatment } from "./experiments.ts";
import type { GamedReason, Tier } from "./eval-contract.ts";
import type { Ending, StartsFrom } from "./repetition-record.ts";
import type { RuleName } from "../contract.ts";

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
  nudges: NudgeFirings | null;
  functionsBefore: number;
  functionsAfter: number;
  gamedReason: GamedReason | null;
  failedBehaviorChecks: { index: number; reason: string }[];
  ending: Ending;
}

export interface RawRowForReport {
  treatmentId: string;
  provenance: { model: string; liubaiSha: string; phrasingPackHash: string | null };
  task?: string;
  delivered?: { packHash: string | null };
}

export interface RunRecordsForReport {
  judged: JudgedRecordForReport[];
  raw: RawRowForReport[];
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
}

export interface TreatmentView {
  treatmentId: string;
  run: string;
  verdictDistribution: string;
  meanTurns: string;
  meanTokensIn: string;
  meanNudgesPerRepetition: string;
  repetitions: RepetitionView[];
}

export interface PerCaseRowView {
  caseId: string;
  cells: string[];
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

function tierLabelOf(records: JudgedRecordForReport[], tierByCaseId: Map<string, Tier>): string {
  const tiers = distinctSorted(records.map((record) => tierByCaseId.get(record.caseId)).filter((tier): tier is Tier => tier !== undefined));
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
  tierByCaseId: Map<string, Tier>,
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
    tierLabel: tierLabelOf(records, tierByCaseId),
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
  nudgesTotal: number | null;
  nudgeTurns: number[];
  functionsBefore: number;
  functionsAfter: number;
  gamedReason: GamedReason | null;
  failedBehaviorChecks: { index: number; reason: string }[];
  ending: Ending;
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
      nudgesTotal: total,
      nudgeTurns: turns,
      functionsBefore: record.functionsBefore,
      functionsAfter: record.functionsAfter,
      gamedReason: record.gamedReason,
      failedBehaviorChecks: record.failedBehaviorChecks,
      ending: record.ending,
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

function humanizeGamedReason(reason: GamedReason): string {
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

function repetitionViewOf(facts: RepetitionFacts): RepetitionView {
  return {
    id: `${facts.run}/${facts.caseId}/${facts.treatmentId}/${facts.repetition}`,
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

function meanOfDefined(values: (number | null)[]): number | null {
  const defined = values.filter((value): value is number => value !== null);
  if (defined.length === 0) return null;
  return defined.reduce((sum, value) => sum + value, 0) / defined.length;
}

function formatMean(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function treatmentViewOf(order: readonly string[], treatment: ExperimentTreatment, facts: RepetitionFacts[]): TreatmentView {
  return {
    treatmentId: treatment.treatmentId,
    run: treatment.run,
    verdictDistribution: distributionLabel(order, facts),
    meanTurns: formatMean(meanOfDefined(facts.map((fact) => fact.turns))),
    meanTokensIn: formatMean(meanOfDefined(facts.map((fact) => fact.tokensIn))),
    meanNudgesPerRepetition: formatMean(meanOfDefined(facts.map((fact) => fact.nudgesTotal))),
    repetitions: facts.map(repetitionViewOf),
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

function perCaseRowsFor(order: readonly string[], successVerdict: string, treatments: TreatmentCaseFacts[]): PerCaseRowView[] {
  const caseIds = distinctSorted(treatments.flatMap((treatment) => treatment.facts.map((fact) => fact.caseId)));

  return caseIds.map((caseId) => {
    const perTreatment = treatments.map((treatment) => ({ treatmentId: treatment.treatmentId, facts: treatment.facts.filter((fact) => fact.caseId === caseId) }));
    const keys = perTreatment.map((treatment) => distributionKey(order, treatment.facts));
    const allMatch = keys.every((key) => key === keys[0]);
    const anyAbnormal = perTreatment.some((treatment) => treatment.facts.some(isAbnormalEnding));

    return {
      caseId,
      cells: perTreatment.map((treatment) => distributionLabel(order, treatment.facts)),
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

function experimentDetailFor(experiment: Experiment, runData: Map<string, RunRecordsForReport>): ExperimentDetailView {
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
    question: experiment.question,
    outcome: experiment.outcome,
    treatmentIds: experiment.treatments.map((treatment) => treatment.treatmentId),
    controlTreatmentId: experiment.controlTreatment,
    successVerdict,
    setupCheck: setupCheckFor(experiment, runData),
    treatments: treatmentsWithFacts.map(({ treatment, facts }) => treatmentViewOf(order, treatment, facts)),
    perCase: perCaseRowsFor(
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
  tierByCaseId: Map<string, Tier>,
  unclaimedRunFolders: string[],
): ReportViewModel {
  const experimentDetails = experiments.map((experiment) => experimentDetailFor(experiment, runData));
  const identicalTreatmentsFlagById = new Map(experimentDetails.map((detail) => [detail.id, detail.setupCheck.identicalTreatments]));

  const milestones = groupByMilestone(experiments).map((group) => ({
    milestone: group.milestone,
    experiments: group.experiments.map((experiment) =>
      experimentViewOf(experiment, runData, tierByCaseId, identicalTreatmentsFlagById.get(experiment.id) ?? false),
    ),
  }));

  return { milestones, unclaimedRunFolders: [...unclaimedRunFolders].sort(), experimentDetails };
}
