import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReportViewModel } from "./report-view.ts";
import type { JudgedRecordForReport, RawRowForReport, RunRecordsForReport } from "./report-view.ts";
import type { Experiment } from "./experiments.ts";
import type { Tier } from "./eval-contract.ts";

function experiment(over: Partial<Experiment>): Experiment {
  return {
    id: "exp",
    name: "Exp Name",
    question: "Does it help?",
    kind: "single-task",
    milestone: "m1",
    treatments: [{ treatmentId: "t1", run: "run-a" }],
    controlTreatment: "t1",
    status: "open",
    outcome: "",
    issues: [],
    ...over,
  };
}

function judgedRecord(caseId: string, treatmentId: string, repetition: number): JudgedRecordForReport {
  return { caseId, treatmentId, repetition };
}

function rawRow(treatmentId: string, model: string): RawRowForReport {
  return { treatmentId, provenance: { model } };
}

function runData(entries: Record<string, RunRecordsForReport>): Map<string, RunRecordsForReport> {
  return new Map(Object.entries(entries));
}

function experimentIdsByMilestone(experiments: Experiment[]): { milestone: string; ids: string[] }[] {
  const view = buildReportViewModel(experiments, runData({}), new Map(), []);
  return view.milestones.map((milestone) => ({ milestone: milestone.milestone, ids: milestone.experiments.map((e) => e.id) }));
}

test("experiments are grouped by milestone in the order the manifest first mentions each milestone", () => {
  const experiments = [
    experiment({ id: "a", milestone: "later" }),
    experiment({ id: "b", milestone: "earlier" }),
    experiment({ id: "c", milestone: "later" }),
  ];

  assert.deepEqual(experimentIdsByMilestone(experiments), [
    { milestone: "later", ids: ["a", "c"] },
    { milestone: "earlier", ids: ["b"] },
  ]);
});

test("an experiment's kind is shown in the manifest's own wording, not its internal kind value", () => {
  const experiments = [experiment({ id: "single", kind: "single-task" }), experiment({ id: "follow-up", kind: "with-follow-up-tasks" })];

  const view = buildReportViewModel(experiments, runData({}), new Map(), []);

  assert.deepEqual(
    view.milestones[0]!.experiments.map((e) => e.kindLabel),
    ["single task", "with follow-up tasks"],
  );
});

test("model and difficulty tier come from a treatment's own rows and the case's manifest tier", () => {
  const experiments = [
    experiment({ treatments: [{ treatmentId: "rails-default", run: "run-a" }], controlTreatment: "rails-default" }),
  ];
  const records = runData({
    "run-a": { judged: [judgedRecord("case-hard", "rails-default", 1)], raw: [rawRow("rails-default", "deepseek-v4-flash")] },
  });
  const tierByCaseId = new Map<string, Tier>([["case-hard", "hard"]]);

  const view = buildReportViewModel(experiments, records, tierByCaseId, []);

  assert.deepEqual(
    { model: view.milestones[0]!.experiments[0]!.model, tierLabel: view.milestones[0]!.experiments[0]!.tierLabel },
    { model: "deepseek-v4-flash", tierLabel: "hard cases" },
  );
});

test("model and difficulty tier are aggregated over every treatment, even when they live in different run folders", () => {
  const experiments = [
    experiment({
      treatments: [
        { treatmentId: "coaching-v1", run: "st-coaching-v1-hard-flash" },
        { treatmentId: "bare-metric-v1", run: "st-bare-metric-v1-easy-flash" },
      ],
      controlTreatment: "coaching-v1",
    }),
  ];
  const records = runData({
    "st-coaching-v1-hard-flash": {
      judged: [judgedRecord("case-hard", "coaching-v1", 1)],
      raw: [rawRow("coaching-v1", "deepseek-v4-flash")],
    },
    "st-bare-metric-v1-easy-flash": {
      judged: [judgedRecord("case-easy", "bare-metric-v1", 1)],
      raw: [rawRow("bare-metric-v1", "qwen-3.6-35b")],
    },
  });
  const tierByCaseId = new Map<string, Tier>([
    ["case-hard", "hard"],
    ["case-easy", "easy"],
  ]);

  const view = buildReportViewModel(experiments, records, tierByCaseId, []);

  assert.deepEqual(
    { model: view.milestones[0]!.experiments[0]!.model, tierLabel: view.milestones[0]!.experiments[0]!.tierLabel },
    { model: "deepseek-v4-flash, qwen-3.6-35b", tierLabel: "easy cases, hard cases" },
  );
});

test("size names how many cases and how many repetitions per treatment the judged records carry", () => {
  const experiments = [experiment({ treatments: [{ treatmentId: "rails-default", run: "run-a" }], controlTreatment: "rails-default" })];
  const records = runData({
    "run-a": {
      judged: [judgedRecord("case-one", "rails-default", 1), judgedRecord("case-one", "rails-default", 2), judgedRecord("case-one", "rails-default", 3)],
      raw: [],
    },
  });

  const view = buildReportViewModel(experiments, records, new Map(), []);

  assert.equal(view.milestones[0]!.experiments[0]!.size, "1 case × 3 repetitions per treatment");
});

test("size reports the largest repetition count across cases when they disagree, rather than an average", () => {
  const experiments = [experiment({ treatments: [{ treatmentId: "rails-default", run: "run-a" }], controlTreatment: "rails-default" })];
  const records = runData({
    "run-a": {
      judged: [
        judgedRecord("case-one", "rails-default", 1),
        judgedRecord("case-one", "rails-default", 2),
        judgedRecord("case-one", "rails-default", 3),
        judgedRecord("case-one", "rails-default", 4),
        judgedRecord("case-two", "rails-default", 1),
      ],
      raw: [],
    },
  });

  const view = buildReportViewModel(experiments, records, new Map(), []);

  assert.equal(view.milestones[0]!.experiments[0]!.size, "2 cases × 4 repetitions per treatment");
});

test("an experiment whose treatments have no rows yet still renders with empty model, tier and size", () => {
  const experiments = [experiment({ treatments: [{ treatmentId: "rails-default", run: "run-missing" }], controlTreatment: "rails-default" })];

  const view = buildReportViewModel(experiments, runData({}), new Map(), []);
  const rendered = view.milestones[0]!.experiments[0]!;

  assert.deepEqual({ model: rendered.model, tierLabel: rendered.tierLabel, size: rendered.size }, {
    model: "",
    tierLabel: "",
    size: "0 cases × 0 repetitions per treatment",
  });
});

test("run folders no experiment claims are listed sorted, regardless of input order", () => {
  const view = buildReportViewModel([], runData({}), new Map(), ["zzz-run", "aaa-run"]);

  assert.deepEqual(view.unclaimedRunFolders, ["aaa-run", "zzz-run"]);
});
