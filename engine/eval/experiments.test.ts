import { test } from "node:test";
import assert from "node:assert/strict";

import { validateExperiments, loadExperiments, loadTreatmentIdsByRun } from "./experiments.ts";
import type { Experiment } from "./experiments.ts";

function singleTaskExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: "exp-1",
    name: "experiment one",
    question: "does it work?",
    kind: "single-task",
    milestone: "m1",
    treatments: [{ treatmentId: "control", run: "run-1" }],
    controlTreatment: "control",
    status: "open",
    outcome: "",
    issues: [],
    ...overrides,
  };
}

function followUpExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return singleTaskExperiment({ kind: "with-follow-up-tasks", sourceRun: "run-1", ...overrides });
}

function knownNames(overrides: Partial<{ treatmentIdsByRun: Record<string, string[]> }> = {}): {
  treatmentIdsByRun: Record<string, string[]>;
} {
  return { treatmentIdsByRun: { "run-1": ["control"] }, ...overrides };
}

function assertNoViolations(violations: string[]): void {
  assert.deepEqual(violations, []);
}

function assertViolationMatching(violations: string[], pattern: RegExp): void {
  assert.ok(
    violations.some((v) => pattern.test(v)),
    `expected a violation matching ${pattern} in ${JSON.stringify(violations)}`,
  );
}

test("validateExperiments_reports_no_violations_for_a_well_formed_experiment", () => {
  const violations = validateExperiments([singleTaskExperiment()], knownNames());

  assertNoViolations(violations);
});

test("validateExperiments_reports_an_experiment_id_used_more_than_once", () => {
  const experiments = [singleTaskExperiment({ id: "dup" }), singleTaskExperiment({ id: "dup" })];

  const violations = validateExperiments(experiments, knownNames());

  assertViolationMatching(violations, /dup/);
});

test("validateExperiments_reports_a_treatment_naming_a_run_folder_that_does_not_exist", () => {
  const experiment = singleTaskExperiment({ treatments: [{ treatmentId: "control", run: "no-such-run" }] });

  const violations = validateExperiments([experiment], knownNames());

  assertViolationMatching(violations, /no-such-run/);
});

test("validateExperiments_reports_a_treatment_id_that_its_run_folder_does_not_contain", () => {
  const experiment = singleTaskExperiment({
    treatments: [{ treatmentId: "no-such-treatment", run: "run-1" }],
    controlTreatment: "no-such-treatment",
  });

  const violations = validateExperiments([experiment], knownNames());

  assertViolationMatching(violations, /run-1/);
  assertViolationMatching(violations, /no-such-treatment/);
});

test("validateExperiments_reports_a_controlTreatment_that_is_not_among_the_experiment's_own_treatments", () => {
  const experiment = singleTaskExperiment({
    treatments: [{ treatmentId: "control", run: "run-1" }],
    controlTreatment: "not-a-treatment-of-this-experiment",
  });

  const violations = validateExperiments([experiment], knownNames());

  assertViolationMatching(violations, /not-a-treatment-of-this-experiment/);
});

test("validateExperiments_reports_a_follow_up_experiment_with_no_sourceRun", () => {
  const experiment = singleTaskExperiment({ kind: "with-follow-up-tasks" });

  const violations = validateExperiments([experiment], knownNames());

  assertViolationMatching(violations, /sourceRun/);
});

test("validateExperiments_reports_a_follow_up_experiment_whose_sourceRun_names_a_run_folder_that_does_not_exist", () => {
  const experiment = followUpExperiment({ sourceRun: "no-such-run" });

  const violations = validateExperiments([experiment], knownNames());

  assertViolationMatching(violations, /no-such-run/);
});

test("validateExperiments_reports_a_single_task_experiment_that_carries_a_sourceRun", () => {
  const experiment = singleTaskExperiment({ sourceRun: "run-1" });

  const violations = validateExperiments([experiment], knownNames());

  assertViolationMatching(violations, /sourceRun/);
});

test("loadTreatmentIdsByRun_lists_the_distinct_treatmentIds_the_committed_run_folder_actually_contains", () => {
  const byRun = loadTreatmentIdsByRun();

  assert.deepEqual(byRun["numberless-prompt-v2-hard-flash"], ["cc-delta-numberless-prompt", "cc-delta-prompt", "control"]);
});

test("validateExperiments_finds_no_violations_in_the_committed_experiments_json_against_the_repo's_real_run_data", () => {
  const experiments = loadExperiments();
  const known = { treatmentIdsByRun: loadTreatmentIdsByRun() };

  const violations = validateExperiments(experiments, known);

  assertNoViolations(violations);
});
