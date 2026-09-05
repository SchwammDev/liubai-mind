import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runReport } from "./report.ts";
import type { Experiment } from "./experiments.ts";
import type { RawRow } from "./eval-contract.ts";
import { CORPUS_DIR, tempDir, writeRun } from "./run-doubles.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CASE_ID = "ts-telemetry-pipeline";
const ENTRY_FILE = "process_batch.ts";
const TREATMENT = "rails-default";
const UNSCORED_RUN = "unscored-run";

function unscoredRow(): RawRow {
  return {
    caseId: CASE_ID,
    treatmentId: TREATMENT,
    repetition: 1,
    provenance: {
      treatmentId: TREATMENT,
      phrasingPackHash: null,
      liubaiSha: "3250ea4",
      model: "aqueduct/deepseek-v4-flash-284b",
      collectedAt: "2026-09-05T00:00:00.000Z",
    },
    files: {},
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
  };
}

function experimentClaiming(run: string): Experiment {
  return {
    id: "exp",
    name: "Exp",
    question: "Does it help?",
    kind: "single-task",
    milestone: "m1",
    treatments: [{ treatmentId: TREATMENT, run }],
    controlTreatment: TREATMENT,
    status: "open",
    outcome: "",
    issues: [],
  };
}

function reportOn(runsRoot: string): { experimentsPath: string; corpusDir: string; runsDir: string; repoRoot: string; outPath: string } {
  return {
    runsDir: runsRoot,
    experimentsPath: join(runsRoot, "experiments.json"),
    corpusDir: CORPUS_DIR,
    repoRoot: REPO_ROOT,
    outPath: join(runsRoot, "report.html"),
  };
}

function guidanceGivenFor(status: number, stdout: string, run: string): { status: number; namesTheRun: boolean; tellsToScoreFirst: boolean } {
  return { status, namesTheRun: stdout.includes(run), tellsToScoreFirst: stdout.includes(`liubai eval score --run ${run}`) };
}

test("runReport tells the user to score a run before it can be reported on, instead of a raw ENOENT", async () => {
  const runsRoot = tempDir("report-unscored-");
  writeRun(join(runsRoot, UNSCORED_RUN), [unscoredRow()], {});
  writeFileSync(join(runsRoot, "experiments.json"), JSON.stringify([experimentClaiming(UNSCORED_RUN)]));

  const result = await runReport(reportOn(runsRoot));

  assert.deepEqual(guidanceGivenFor(result.status, result.stdout, UNSCORED_RUN), {
    status: 1,
    namesTheRun: true,
    tellsToScoreFirst: true,
  });
});

function minimalJudgedRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    caseId: CASE_ID,
    treatmentId: TREATMENT,
    repetition: 1,
    startsFrom: { kind: "original-source" },
    transcriptPath: null,
    verdict: "genuine-fix",
    gamedReason: null,
    failedBehaviorChecks: [],
    decisionPointsBefore: 10,
    decisionPointsAfter: 8,
    entrySymbolComplexityBefore: 5,
    entrySymbolComplexityAfter: 4,
    functionsBefore: 3,
    functionsAfter: 3,
    linesAdded: 1,
    linesRemoved: 1,
    turns: 2,
    tokensIn: 10,
    tokensOut: 5,
    durationMs: 1000,
    ending: "final-text",
    retries: 0,
    nudges: null,
    toolCalls: null,
    firstEditTurn: null,
    filesCreated: [],
    reasoning: { requested: null, present: false },
    contaminated: false,
    consultedRail: false,
    ...over,
  };
}

function minimalRawRow(repetition: number, files: Record<string, string>, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseId: CASE_ID,
    treatmentId: TREATMENT,
    repetition,
    provenance: { treatmentId: TREATMENT, phrasingPackHash: null, liubaiSha: "3250ea4", model: "test-model", collectedAt: "2026-09-05T00:00:00.000Z" },
    files,
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    ...over,
  };
}

function writeHandCraftedRun(runDir: string, judgedRows: Record<string, unknown>[], rawRows: Record<string, unknown>[]): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "judged.jsonl"), `${judgedRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(join(runDir, "raw.jsonl"), `${rawRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function followUpExperimentSourcedFrom(sourceRun: string, followUpRun: string): Experiment {
  return {
    id: "follow-up-exp",
    name: "Follow Up",
    question: "Does the change hold?",
    kind: "with-follow-up-tasks",
    milestone: "m1",
    sourceRun,
    treatments: [{ treatmentId: TREATMENT, run: followUpRun }],
    controlTreatment: TREATMENT,
    status: "open",
    outcome: "",
    issues: [],
  };
}

test("runReport loads an experiment's sourceRun even when no experiment claims it as a treatment, so the earlier-change state is found", async () => {
  const runsRoot = tempDir("report-source-run-");
  const SOURCE_RUN = "source-only-run";
  const FOLLOW_RUN = "follow-run";
  const EARLIER_TEXT = "function processBatch() { return 1; }\n";

  writeHandCraftedRun(
    join(runsRoot, SOURCE_RUN),
    [minimalJudgedRow({ repetition: 7 })],
    [minimalRawRow(7, { [ENTRY_FILE]: EARLIER_TEXT })],
  );
  writeHandCraftedRun(
    join(runsRoot, FOLLOW_RUN),
    [minimalJudgedRow({ startsFrom: { kind: "earlier-result", sourceRun: SOURCE_RUN, sourceRepetition: 7 } })],
    [minimalRawRow(1, { [ENTRY_FILE]: "function processBatch() { return 2; }\n" })],
  );
  writeFileSync(join(runsRoot, "experiments.json"), JSON.stringify([followUpExperimentSourcedFrom(SOURCE_RUN, FOLLOW_RUN)]));

  const result = await runReport({ ...reportOn(runsRoot) });

  assert.deepEqual(
    { status: result.status, pageMentionsEarlierChangeText: readFileSync(join(runsRoot, "report.html"), "utf8").includes(EARLIER_TEXT) },
    { status: 0, pageMentionsEarlierChangeText: true },
  );
});
