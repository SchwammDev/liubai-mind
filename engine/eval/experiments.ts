import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type ExperimentKind = "single-task" | "with-follow-up-tasks";

export type ExperimentStatus = "open" | "concluded" | "void" | "reference";

export interface ExperimentTreatment {
  treatmentId: string;
  run: string;
}

export interface Experiment {
  id: string;
  name: string;
  question: string;
  kind: ExperimentKind;
  milestone: string;
  sourceRun?: string;
  treatments: ExperimentTreatment[];
  controlTreatment: string;
  status: ExperimentStatus;
  outcome: string;
  issues: number[];
}

interface KnownNames {
  treatmentIdsByRun: Record<string, string[]>;
}

function runFolderExists(run: string, known: KnownNames): boolean {
  return run in known.treatmentIdsByRun;
}

function duplicateIdViolations(experiments: Experiment[]): string[] {
  const seen = new Set<string>();
  const reported = new Set<string>();

  for (const experiment of experiments) {
    if (seen.has(experiment.id)) reported.add(experiment.id);
    seen.add(experiment.id);
  }

  return [...reported].map((id) => `duplicate experiment id: ${id}`);
}

function unknownRunFolderViolations(experiment: Experiment, known: KnownNames): string[] {
  return experiment.treatments
    .filter((treatment) => !runFolderExists(treatment.run, known))
    .map((treatment) => `${experiment.id}: treatment ${treatment.treatmentId} names a run folder that does not exist: ${treatment.run}`);
}

function unknownTreatmentIdViolations(experiment: Experiment, known: KnownNames): string[] {
  return experiment.treatments
    .filter((treatment) => runFolderExists(treatment.run, known))
    .filter((treatment) => !known.treatmentIdsByRun[treatment.run]!.includes(treatment.treatmentId))
    .map((treatment) => `${experiment.id}: run folder ${treatment.run} does not contain treatment id ${treatment.treatmentId}`);
}

function unknownControlTreatmentViolations(experiment: Experiment): string[] {
  const ownTreatmentIds = experiment.treatments.map((treatment) => treatment.treatmentId);
  if (ownTreatmentIds.includes(experiment.controlTreatment)) return [];

  return [`${experiment.id}: controlTreatment is not among its own treatments: ${experiment.controlTreatment}`];
}

function followUpSourceRunViolations(experiment: Experiment, known: KnownNames): string[] {
  if (experiment.sourceRun === undefined) {
    return [`${experiment.id}: kind "with-follow-up-tasks" requires sourceRun`];
  }
  if (!runFolderExists(experiment.sourceRun, known)) {
    return [`${experiment.id}: sourceRun names a run folder that does not exist: ${experiment.sourceRun}`];
  }
  return [];
}

function singleTaskSourceRunViolations(experiment: Experiment): string[] {
  if (experiment.sourceRun === undefined) return [];

  return [`${experiment.id}: kind "single-task" must not carry sourceRun: ${experiment.sourceRun}`];
}

function sourceRunViolations(experiment: Experiment, known: KnownNames): string[] {
  return experiment.kind === "with-follow-up-tasks"
    ? followUpSourceRunViolations(experiment, known)
    : singleTaskSourceRunViolations(experiment);
}

export function validateExperiments(experiments: Experiment[], known: { treatmentIdsByRun: Record<string, string[]> }): string[] {
  const violations: string[] = [...duplicateIdViolations(experiments)];

  for (const experiment of experiments) {
    violations.push(...unknownRunFolderViolations(experiment, known));
    violations.push(...unknownTreatmentIdViolations(experiment, known));
    violations.push(...unknownControlTreatmentViolations(experiment));
    violations.push(...sourceRunViolations(experiment, known));
  }

  return violations;
}

export function loadExperiments(path: string = join(import.meta.dirname, "experiments.json")): Experiment[] {
  return JSON.parse(readFileSync(path, "utf8")) as Experiment[];
}

function treatmentIdsInRun(runDir: string): string[] {
  const rows = readFileSync(join(runDir, "raw.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { treatmentId: string });

  return [...new Set(rows.map((row) => row.treatmentId))].sort();
}

export function loadTreatmentIdsByRun(runsDir: string = join(import.meta.dirname, "runs")): Record<string, string[]> {
  const runFolders = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const result: Record<string, string[]> = {};
  for (const runFolder of runFolders) {
    result[runFolder] = treatmentIdsInRun(join(runsDir, runFolder));
  }
  return result;
}
