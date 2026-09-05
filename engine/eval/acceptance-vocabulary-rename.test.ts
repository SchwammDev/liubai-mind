import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCliArgs, runEval } from "./eval-cli.ts";
import { runCollect } from "./collect.ts";
import type { CollectOpts, CollectResult } from "./collect.ts";
import { healthyProbeReporter } from "./probe-doubles.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CORPUS_DIR = join(import.meta.dirname, "corpus");
const RUN_NAME = "numberless-prompt-v2-hard-flash";
const RUN_DIR = join(import.meta.dirname, "runs", RUN_NAME);
const TREATMENT_ID = "control";
const CASE_ID = "ts-flag-parser";

const REPETITIONS_PER_TREATMENT = 48;
const PRE_RENAME_VERDICT_COUNTS: Record<string, Record<string, number>> = {
  "cc-delta-prompt": { "genuine-fix": 46, "bar-missed": 1, "timed-out": 1 },
  "cc-delta-numberless-prompt": { "genuine-fix": 43, "bar-missed": 3, untouched: 1, "timed-out": 1 },
  control: { "genuine-fix": 12, "bar-missed": 36 },
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function silentSpawner(): CollectOpts["spawner"] {
  return async () => ({ exitCode: 0, stdoutJsonl: "", timedOut: false });
}

function collectOptsForOneTreatmentAndOneRepetition(): CollectOpts {
  return {
    repoRoot: REPO_ROOT,
    runDir: tempDir("acceptance-vocab-run-"),
    workRoot: tempDir("acceptance-vocab-work-"),
    model: "vocab-test-model",
    cases: [CASE_ID],
    corpusDir: CORPUS_DIR,
    spawner: silentSpawner(),
    probeSpawner: healthyProbeReporter(),
    repetitions: 1,
    treatments: [TREATMENT_ID],
  } as unknown as CollectOpts;
}

function jsonlRows(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function rawRowsForCase(runDir: string, caseId: string): Record<string, unknown>[] {
  return jsonlRows(join(runDir, "raw.jsonl")).filter((row) => row["caseId"] === caseId);
}

function wholeRunSummaryRow(treatmentId: string): Record<string, unknown> {
  const rows = jsonlRows(join(RUN_DIR, "summary.jsonl")).filter(
    (row) => row["treatmentId"] === treatmentId && row["caseId"] === null && row["tier"] === null,
  );
  assert.equal(rows.length, 1, `expected one whole-run summary row for ${treatmentId}`);
  return rows[0]!;
}

function nonZeroVerdictCounts(row: Record<string, unknown>): Record<string, number> {
  const counts = row["counts"] as Record<string, number>;
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
}

function assertTreatmentScoresAsBeforeTheRename(treatmentId: string): void {
  const row = wholeRunSummaryRow(treatmentId);

  assert.equal(row["total"], REPETITIONS_PER_TREATMENT, `${treatmentId}: repetitions scored`);
  assert.deepEqual(nonZeroVerdictCounts(row), PRE_RENAME_VERDICT_COUNTS[treatmentId], `${treatmentId}: verdict counts`);
}

function assertSummaryRowUsesNewFieldNames(row: Record<string, unknown>): void {
  assert.equal("meanNudges" in row, true);
  assert.equal("conditionId" in row, false);
  assert.equal("meanRailFirings" in row, false);
}

function assertRawRowUsesNewFieldNames(row: Record<string, unknown>): void {
  assert.equal(row["treatmentId"], TREATMENT_ID);
  assert.equal(row["repetition"], 1);
  assert.equal("conditionId" in row, false);
  assert.equal("rep" in row, false);
}

test("scoring the committed numberless-prompt-v2-hard-flash run reproduces the pre-rename verdict counts", async () => {
  const result = await runEval(["score", "--run", RUN_NAME]);

  assert.equal(result.status, 0, result.stdout);
  for (const treatmentId of Object.keys(PRE_RENAME_VERDICT_COUNTS)) assertTreatmentScoresAsBeforeTheRename(treatmentId);
  assertSummaryRowUsesNewFieldNames(wholeRunSummaryRow(TREATMENT_ID));
});

test("collect writes a raw row keyed by treatmentId and repetition, carrying no old field names", async () => {
  const opts = collectOptsForOneTreatmentAndOneRepetition();

  const result: CollectResult = await runCollect(opts);

  assert.equal(result.status, 0);
  const rows = rawRowsForCase(opts.runDir, CASE_ID);
  assert.equal(rows.length, 1);
  assertRawRowUsesNewFieldNames(rows[0]!);
});

function assertParses(argv: string[]): void {
  assert.equal("error" in parseCliArgs(argv), false);
}

function assertUnknown(argv: string[]): void {
  assert.equal("error" in parseCliArgs(argv), true);
}

test("the CLI accepts --repetitions and --treatment and rejects the retired --reps, --condition and second-touch spellings", () => {
  assertParses(["collect", "--run", "x", "--model", "m", "--repetitions", "1", "--treatment", TREATMENT_ID, "--case", CASE_ID]);
  assertUnknown(["collect", "--run", "x", "--model", "m", "--reps", "1"]);
  assertUnknown(["collect", "--run", "x", "--model", "m", "--condition", TREATMENT_ID]);
  assertUnknown(["second-touch", "--run", "x", "--source-run", "y", "--model", "m"]);
});
