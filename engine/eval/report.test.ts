import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { runReport } from "./report.ts";
import type { Experiment } from "./experiments.ts";
import type { RawRow } from "./eval-contract.ts";
import { CORPUS_DIR, tempDir, writeRun } from "./run-doubles.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CASE_ID = "ts-telemetry-pipeline";
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
