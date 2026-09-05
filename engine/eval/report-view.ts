import type { Experiment, ExperimentKind, ExperimentStatus } from "./experiments.ts";
import type { Tier } from "./eval-contract.ts";

export interface JudgedRecordForReport {
  caseId: string;
  treatmentId: string;
  repetition: number;
}

export interface RawRowForReport {
  treatmentId: string;
  provenance: { model: string };
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
}

export interface MilestoneView {
  milestone: string;
  experiments: ExperimentView[];
}

export interface ReportViewModel {
  milestones: MilestoneView[];
  unclaimedRunFolders: string[];
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

function experimentViewOf(experiment: Experiment, runData: Map<string, RunRecordsForReport>, tierByCaseId: Map<string, Tier>): ExperimentView {
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
  const milestones = groupByMilestone(experiments).map((group) => ({
    milestone: group.milestone,
    experiments: group.experiments.map((experiment) => experimentViewOf(experiment, runData, tierByCaseId)),
  }));

  return { milestones, unclaimedRunFolders: [...unclaimedRunFolders].sort() };
}
