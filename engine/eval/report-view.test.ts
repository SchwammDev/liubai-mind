import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReportViewModel } from "./report-view.ts";
import type { JudgedRecordForReport, RawRowForReport, RunRecordsForReport } from "./report-view.ts";
import type { Experiment } from "./experiments.ts";
import type { Tier } from "./eval-contract.ts";
import { RULE } from "../contract.ts";
import type { RuleName } from "../contract.ts";

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

function judgedRecord(caseId: string, treatmentId: string, repetition: number, over: Partial<JudgedRecordForReport> = {}): JudgedRecordForReport {
  return {
    caseId,
    treatmentId,
    repetition,
    verdict: "genuine-fix",
    startsFrom: { kind: "original-source" },
    linesAdded: 0,
    linesRemoved: 0,
    turns: null,
    tokensIn: null,
    nudges: null,
    functionsBefore: 1,
    functionsAfter: 1,
    gamedReason: null,
    failedBehaviorChecks: [],
    ending: "final-text",
    ...over,
  };
}

function rawRow(treatmentId: string, model: string, over: Partial<RawRowForReport> = {}): RawRowForReport {
  return { treatmentId, provenance: { model, liubaiSha: "sha1", phrasingPackHash: null }, ...over };
}

function noFirings(): Record<RuleName, { count: number; turns: number[] }> {
  const entries: [RuleName, { count: number; turns: number[] }][] = (Object.values(RULE) as RuleName[]).map((rule) => [rule, { count: 0, turns: [] }]);
  return Object.fromEntries(entries) as Record<RuleName, { count: number; turns: number[] }>;
}

function firingsOn(rule: RuleName, turns: number[]): Record<RuleName, { count: number; turns: number[] }> {
  const firings = noFirings();
  firings[rule] = { count: turns.length, turns };
  return firings;
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

function experimentDetailFor(exp: Experiment, records: Record<string, RunRecordsForReport>): ReturnType<typeof buildReportViewModel>["experimentDetails"][number] {
  return buildReportViewModel([exp], runData(records), new Map(), []).experimentDetails[0]!;
}

test("a treatment's repetitions are ordered worst first for a single-task experiment", () => {
  const exp = experiment({ treatments: [{ treatmentId: "t1", run: "run-a" }], controlTreatment: "t1", kind: "single-task" });
  const records = {
    "run-a": {
      judged: [
        judgedRecord("case-a", "t1", 1, { verdict: "untouched" }),
        judgedRecord("case-a", "t1", 2, { verdict: "broken" }),
        judgedRecord("case-a", "t1", 3, { verdict: "genuine-fix" }),
      ],
      raw: [],
    },
  };

  const detail = experimentDetailFor(exp, records);

  assert.deepEqual(
    detail.treatments[0]!.repetitions.map((r) => r.verdict),
    ["broken", "untouched", "genuine-fix"],
  );
});

test("a treatment's repetitions are ordered worst first for a with-follow-up-tasks experiment", () => {
  const exp = experiment({ treatments: [{ treatmentId: "t1", run: "run-a" }], controlTreatment: "t1", kind: "with-follow-up-tasks" });
  const records = {
    "run-a": {
      judged: [
        judgedRecord("case-a", "t1", 1, { verdict: "untouched" }),
        judgedRecord("case-a", "t1", 2, { verdict: "regressed" }),
        judgedRecord("case-a", "t1", 3, { verdict: "extended" }),
      ],
      raw: [],
    },
  };

  const detail = experimentDetailFor(exp, records);

  assert.deepEqual(
    detail.treatments[0]!.repetitions.map((r) => r.verdict),
    ["regressed", "untouched", "extended"],
  );
});

test("the setup check says the setup is unverifiable when no row carries a delivery stamp or task text", () => {
  const exp = experiment({
    treatments: [
      { treatmentId: "t1", run: "run-a" },
      { treatmentId: "t2", run: "run-a" },
    ],
    controlTreatment: "t1",
  });
  const records = { "run-a": { judged: [], raw: [rawRow("t1", "model-a"), rawRow("t2", "model-a")] } };

  const detail = experimentDetailFor(exp, records);

  assert.deepEqual(
    { unverifiable: detail.setupCheck.summary.includes("unverifiable"), flagged: detail.setupCheck.identicalTreatments },
    { unverifiable: true, flagged: false },
  );
});

test("the setup check flags identical treatments when their delivered text is byte-identical", () => {
  const exp = experiment({
    treatments: [
      { treatmentId: "t1", run: "run-a" },
      { treatmentId: "t2", run: "run-a" },
    ],
    controlTreatment: "t1",
  });
  const records = {
    "run-a": {
      judged: [],
      raw: [rawRow("t1", "model-a", { task: "fix the thing" }), rawRow("t2", "model-a", { task: "fix the thing" })],
    },
  };

  const detail = experimentDetailFor(exp, records);

  assert.equal(detail.setupCheck.identicalTreatments, true);
});

test("the setup check does not flag treatments whose delivered text differs", () => {
  const exp = experiment({
    treatments: [
      { treatmentId: "t1", run: "run-a" },
      { treatmentId: "t2", run: "run-a" },
    ],
    controlTreatment: "t1",
  });
  const records = {
    "run-a": {
      judged: [],
      raw: [rawRow("t1", "model-a", { task: "fix the thing" }), rawRow("t2", "model-a", { task: "fix the other thing" })],
    },
  };

  const detail = experimentDetailFor(exp, records);

  assert.equal(detail.setupCheck.identicalTreatments, false);
});

test("the experiments list row carries the same identical-treatments flag the setup check raised", () => {
  const exp = experiment({
    id: "exp-flagged",
    treatments: [
      { treatmentId: "t1", run: "run-a" },
      { treatmentId: "t2", run: "run-a" },
    ],
    controlTreatment: "t1",
  });
  const records = {
    "run-a": {
      judged: [],
      raw: [rawRow("t1", "model-a", { task: "same text" }), rawRow("t2", "model-a", { task: "same text" })],
    },
  };

  const view = buildReportViewModel([exp], runData(records), new Map(), []);

  assert.equal(view.milestones[0]!.experiments[0]!.identicalTreatmentsFlag, true);
});

test("a case's row names no divergence when every treatment reaches the same verdicts and nothing ends abnormally", () => {
  const exp = experiment({
    treatments: [
      { treatmentId: "t1", run: "run-a" },
      { treatmentId: "t2", run: "run-a" },
    ],
    controlTreatment: "t1",
    kind: "single-task",
  });
  const records = {
    "run-a": {
      judged: [judgedRecord("case-a", "t1", 1, { verdict: "genuine-fix" }), judgedRecord("case-a", "t2", 1, { verdict: "genuine-fix" })],
      raw: [],
    },
  };

  const detail = experimentDetailFor(exp, records);

  assert.equal(detail.perCase[0]!.wherePart, "");
});

test("a case's row names the treatment, repetition and verdict where a treatment's result parts from the rest", () => {
  const exp = experiment({
    treatments: [
      { treatmentId: "coaching-v1", run: "run-a" },
      { treatmentId: "bare-metric-v1", run: "run-a" },
    ],
    controlTreatment: "coaching-v1",
    kind: "with-follow-up-tasks",
  });
  const records = {
    "run-a": {
      judged: [
        judgedRecord("case-a", "coaching-v1", 1, { verdict: "extended" }),
        judgedRecord("case-a", "bare-metric-v1", 3, { verdict: "regressed", failedBehaviorChecks: [{ index: 0, reason: "helper split" }] }),
      ],
      raw: [],
    },
  };

  const detail = experimentDetailFor(exp, records);

  assert.equal(detail.perCase[0]!.wherePart, "bare-metric-v1 · repetition 3 · regressed · helper split");
});

test("the detail cell names only the facts no other column carries", () => {
  const exp = experiment({ treatments: [{ treatmentId: "t1", run: "run-a" }], controlTreatment: "t1", kind: "single-task" });
  const records = {
    "run-a": {
      judged: [
        judgedRecord("case-a", "t1", 1, {
          verdict: "gamed",
          gamedReason: "helper-split",
          functionsBefore: 2,
          functionsAfter: 5,
          nudges: firingsOn(RULE.ccDelta, [2, 4]),
        }),
      ],
      raw: [],
    },
  };

  const detail = experimentDetailFor(exp, records);

  assert.equal(detail.treatments[0]!.repetitions[0]!.detail, "helper split · 3 functions added · nudges at turns 2, 4");
});

test("a gamed reason appears as words, not the raw slug, in the where-they-part cell too", () => {
  const exp = experiment({
    treatments: [
      { treatmentId: "t1", run: "run-a" },
      { treatmentId: "t2", run: "run-a" },
    ],
    controlTreatment: "t1",
    kind: "single-task",
  });
  const records = {
    "run-a": {
      judged: [
        judgedRecord("case-a", "t1", 1, { verdict: "genuine-fix" }),
        judgedRecord("case-a", "t2", 2, { verdict: "gamed", gamedReason: "helper-split" }),
      ],
      raw: [],
    },
  };

  const detail = experimentDetailFor(exp, records);

  assert.equal(detail.perCase[0]!.wherePart, "t2 · repetition 2 · gamed · helper split");
});

test("a repetition's nudged flag reflects whether any nudge fired, independent of how the count is displayed", () => {
  const exp = experiment({ treatments: [{ treatmentId: "t1", run: "run-a" }], controlTreatment: "t1", kind: "single-task" });
  const records = {
    "run-a": {
      judged: [
        judgedRecord("case-a", "t1", 1, { nudges: firingsOn(RULE.ccDelta, [2]) }),
        judgedRecord("case-a", "t1", 2, { nudges: null }),
      ],
      raw: [],
    },
  };

  const detail = experimentDetailFor(exp, records);

  assert.deepEqual(
    detail.treatments[0]!.repetitions.map((r) => r.nudged),
    [true, false],
  );
});

test("the setup check names which treatments carry evidence when only one does, instead of an empty summary", () => {
  const exp = experiment({
    treatments: [
      { treatmentId: "t1", run: "run-a" },
      { treatmentId: "t2", run: "run-a" },
    ],
    controlTreatment: "t1",
  });
  const records = { "run-a": { judged: [], raw: [rawRow("t1", "model-a", { task: "fix the thing" })] } };

  const detail = experimentDetailFor(exp, records);

  assert.equal(detail.setupCheck.summary, "t1 carries a delivery stamp or task text; t2 carries none");
});

test("the setup check reports when delivered text differs across treatments, without printing the text itself", () => {
  const exp = experiment({
    treatments: [
      { treatmentId: "t1", run: "run-a" },
      { treatmentId: "t2", run: "run-a" },
    ],
    controlTreatment: "t1",
  });
  const records = {
    "run-a": {
      judged: [],
      raw: [rawRow("t1", "model-a", { task: "fix the thing" }), rawRow("t2", "model-a", { task: "fix the other thing" })],
    },
  };

  const detail = experimentDetailFor(exp, records);

  assert.deepEqual(
    { summary: detail.setupCheck.summary, leaksDeliveredText: detail.setupCheck.summary.includes("fix the") },
    { summary: "same liubai commit: sha1 · same model: model-a · same wording pack: none · delivered text differs", leaksDeliveredText: false },
  );
});

test("a treatment's means are computed only from repetitions that carry cost data", () => {
  const exp = experiment({ treatments: [{ treatmentId: "t1", run: "run-a" }], controlTreatment: "t1", kind: "single-task" });
  const records = {
    "run-a": {
      judged: [
        judgedRecord("case-a", "t1", 1, { turns: 10, tokensIn: 100, nudges: firingsOn(RULE.ccDelta, [1]) }),
        judgedRecord("case-a", "t1", 2, { turns: null, tokensIn: null, nudges: null }),
      ],
      raw: [],
    },
  };

  const detail = experimentDetailFor(exp, records);

  assert.deepEqual(
    {
      meanTurns: detail.treatments[0]!.meanTurns,
      meanTokensIn: detail.treatments[0]!.meanTokensIn,
      meanNudges: detail.treatments[0]!.meanNudgesPerRepetition,
    },
    { meanTurns: "10.0", meanTokensIn: "100.0", meanNudges: "1.0" },
  );
});
