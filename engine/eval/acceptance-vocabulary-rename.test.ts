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
const TREATMENT_ID = "control";
const CASE_ID = "ts-flag-parser";

const EXPECTED_SCORE_STATUS = 1;
const EXPECTED_SCORE_STDOUT =
  "score: delivery violation [missing-stamp] cc-delta-prompt/ts-order-fulfillment#7: no delivery stamp while other rows in this run carry one — rails likely never loaded for this repetition";

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

function rawRowsForCase(runDir: string, caseId: string): Record<string, unknown>[] {
  const raw = readFileSync(join(runDir, "raw.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row["caseId"] === caseId);
}

function assertRowUsesNewFieldNames(row: Record<string, unknown>): void {
  assert.equal(row["treatmentId"], TREATMENT_ID);
  assert.equal(row["repetition"], 1);
  assert.equal("conditionId" in row, false);
  assert.equal("rep" in row, false);
}

test("scoring the committed numberless-prompt-v2-hard-flash run is unchanged by the vocabulary rename", async () => {
  const result = await runEval(["score", "--run", RUN_NAME]);

  assert.equal(result.status, EXPECTED_SCORE_STATUS);
  assert.equal(result.stdout, EXPECTED_SCORE_STDOUT);
});

test("collect writes a raw row keyed by treatmentId and repetition, carrying no old field names", async () => {
  const opts = collectOptsForOneTreatmentAndOneRepetition();

  const result: CollectResult = await runCollect(opts);

  assert.equal(result.status, 0);
  const rows = rawRowsForCase(opts.runDir, CASE_ID);
  assert.equal(rows.length, 1);
  assertRowUsesNewFieldNames(rows[0]!);
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
