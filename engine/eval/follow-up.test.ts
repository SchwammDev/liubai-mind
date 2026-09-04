import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runFollowUp } from "./follow-up.ts";
import type { FollowUpOpts } from "./follow-up.ts";
import type { RunSpec, RunOutcome, PiSpawner } from "./spawner.ts";
import type { RawRow, Provenance } from "./eval-contract.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SOURCE_RUN_NAME = "source-run";
const FLAG_PARSER_SEED = readFileSync(join(REPO_ROOT, "engine", "eval", "corpus", "ts-flag-parser", "parse_flags.ts.case"), "utf8");
const MUTATED_FLAG_PARSER = `${FLAG_PARSER_SEED}\n// touched\n`;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseProvenance(over: Partial<Provenance> = {}): Provenance {
  return {
    treatmentId: "rails-default",
    phrasingPackHash: null,
    liubaiSha: "abc1234",
    model: "aqueduct/deepseek-v4-flash-284b",
    collectedAt: "2026-08-29T00:00:00.000Z",
    ...over,
  };
}

function sourceRow(over: Partial<RawRow> = {}): RawRow {
  return {
    caseId: "ts-flag-parser",
    treatmentId: "rails-default",
    repetition: 1,
    provenance: baseProvenance({ treatmentId: over.treatmentId ?? "rails-default" }),
    files: { "parse_flags.ts": MUTATED_FLAG_PARSER },
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    ...over,
  };
}

function writeSourceRun(rows: RawRow[]): string {
  const sourceRunDir = tempDir("eval-source-run-");
  writeFileSync(join(sourceRunDir, "raw.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return sourceRunDir;
}

function baseOpts(sourceRunDir: string, over: Partial<FollowUpOpts> = {}): FollowUpOpts {
  return {
    repoRoot: REPO_ROOT,
    runDir: tempDir("eval-follow-up-run-"),
    workRoot: tempDir("eval-work-"),
    sourceRunDir,
    sourceRun: SOURCE_RUN_NAME,
    model: "aqueduct/deepseek-v4-flash-284b",
    ...over,
  };
}

function fixedOutcomeSpawner(outcome: RunOutcome): PiSpawner {
  return async () => outcome;
}

function readRawRows(runDir: string): RawRow[] {
  const raw = readFileSync(join(runDir, "raw.jsonl"), "utf8");
  return raw.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as RawRow);
}

function rowIdentity(row: RawRow): string {
  const st = row.followUp;
  return `${row.caseId}/${row.treatmentId}/${st?.control ? "control" : `from-repetition:${st?.sourceRepetition}`}`;
}

function recordingSpawner(): { spawner: PiSpawner; calls: RunSpec[] } {
  const calls: RunSpec[] = [];
  const spawner: PiSpawner = async (spec) => {
    calls.push(spec);
    return { exitCode: 0, stdoutJsonl: "", timedOut: false };
  };
  return { spawner, calls };
}

function fileCapturingSpawner(filename: string): { spawner: PiSpawner; capturedContents: (string | undefined)[] } {
  const capturedContents: (string | undefined)[] = [];
  const spawner: PiSpawner = async (spec) => {
    try {
      capturedContents.push(readFileSync(join(spec.cwd, filename), "utf8"));
    } catch {
      capturedContents.push(undefined);
    }
    return { exitCode: 0, stdoutJsonl: "", timedOut: false };
  };
  return { spawner, capturedContents };
}

test("runFollowUp_never_seeds_from_a_timed_out_source_row", async () => {
  const rows = [
    sourceRow({ treatmentId: "rails-default", repetition: 1, timedOut: true }),
    sourceRow({ treatmentId: "rails-default", repetition: 2 }),
  ];
  const sourceRunDir = writeSourceRun(rows);
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts(sourceRunDir, { spawner });

  await runFollowUp(opts);

  const identities = readRawRows(opts.runDir).map(rowIdentity).sort();
  assert.deepEqual(identities, ["ts-flag-parser/rails-default/control", "ts-flag-parser/rails-default/from-repetition:2"]);
});

test("runFollowUp_derives_one_earlierResult_item_per_touched_non_errored_source_row_and_one_control_item_per_arm", async () => {
  const rows = [
    sourceRow({ treatmentId: "rails-default", repetition: 1, files: { "parse_flags.ts": MUTATED_FLAG_PARSER } }),
    sourceRow({ treatmentId: "rails-default", repetition: 2, agentError: "boom" }),
    sourceRow({ treatmentId: "bare-metric-v1", repetition: 1, files: { "parse_flags.ts": FLAG_PARSER_SEED } }),
    sourceRow({ caseId: "ts-order-validator", treatmentId: "rails-default", repetition: 1, files: {} }),
  ];
  const sourceRunDir = writeSourceRun(rows);
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts(sourceRunDir, { spawner });

  const result = await runFollowUp(opts);

  assert.equal(result.rowsWritten, 3);
  const identities = readRawRows(opts.runDir).map(rowIdentity).sort();
  assert.deepEqual(identities, [
    "ts-flag-parser/bare-metric-v1/control",
    "ts-flag-parser/rails-default/control",
    "ts-flag-parser/rails-default/from-repetition:1",
  ]);
});

test("runFollowUp_skips_a_source_row_whose_entry_file_was_dropped_from_the_snapshot", async () => {
  const rows = [sourceRow({ files: { "notes.md": "entry exceeded the snapshot cap" } })];
  const sourceRunDir = writeSourceRun(rows);
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts(sourceRunDir, { spawner });

  await runFollowUp(opts);

  const identities = readRawRows(opts.runDir).map(rowIdentity);
  assert.deepEqual(identities, ["ts-flag-parser/rails-default/control"]);
});

test("runFollowUp_materializes_every_file_from_the_source_row_into_the_fresh_workdir_before_spawning", async () => {
  const helperContent = "export function helper() { return 1; }\n";
  const rows = [sourceRow({ files: { "parse_flags.ts": MUTATED_FLAG_PARSER, "helpers.ts": helperContent } })];
  const sourceRunDir = writeSourceRun(rows);
  const capturingFlags = fileCapturingSpawner("parse_flags.ts");
  const opts = baseOpts(sourceRunDir, { spawner: capturingFlags.spawner });

  await runFollowUp(opts);

  assert.equal(capturingFlags.capturedContents[0], MUTATED_FLAG_PARSER);
});

test("runFollowUp_materializes_extra_files_the_source_row_created_beside_the_declared_entry", async () => {
  const helperContent = "export function helper() { return 1; }\n";
  const rows = [sourceRow({ files: { "parse_flags.ts": MUTATED_FLAG_PARSER, "helpers.ts": helperContent } })];
  const sourceRunDir = writeSourceRun(rows);
  const capturingHelpers = fileCapturingSpawner("helpers.ts");
  const opts = baseOpts(sourceRunDir, { spawner: capturingHelpers.spawner });

  await runFollowUp(opts);

  assert.equal(capturingHelpers.capturedContents[0], helperContent);
});

test("runFollowUp_spawns_the_earlierResult_item_under_the_same_treatment_env_as_the_source_row", async () => {
  const rows = [sourceRow({ treatmentId: "control", files: { "parse_flags.ts": MUTATED_FLAG_PARSER } })];
  const sourceRunDir = writeSourceRun(rows);
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts(sourceRunDir, { spawner });

  await runFollowUp(opts);

  assert.equal(calls[0]?.env.LIUBAI_RAILS_OFF, "1");
});

test("runFollowUp_spawns_the_extension_task_rather_than_the_original_case_task", async () => {
  const rows = [sourceRow({ files: { "parse_flags.ts": MUTATED_FLAG_PARSER } })];
  const sourceRunDir = writeSourceRun(rows);
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts(sourceRunDir, { spawner });

  await runFollowUp(opts);

  const extension = JSON.parse(readFileSync(join(REPO_ROOT, "engine", "eval", "corpus", "ts-flag-parser", "extension.json"), "utf8"));
  assert.equal(calls[0]?.task, extension.task);
});

test("runFollowUp_stamps_earlierResult_rows_with_their_source_run_and_source_repetition", async () => {
  const rows = [sourceRow({ treatmentId: "rails-default", repetition: 4, files: { "parse_flags.ts": MUTATED_FLAG_PARSER } })];
  const sourceRunDir = writeSourceRun(rows);
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts(sourceRunDir, { spawner });

  await runFollowUp(opts);

  const earlierResult = readRawRows(opts.runDir).find((r) => r.followUp?.control === false);
  assert.deepEqual(earlierResult?.followUp, { sourceRun: SOURCE_RUN_NAME, sourceRepetition: 4, control: false });
});

test("runFollowUp_stamps_control_rows_with_a_null_source_repetition", async () => {
  const rows = [sourceRow({ treatmentId: "rails-default", repetition: 1, files: { "parse_flags.ts": MUTATED_FLAG_PARSER } })];
  const sourceRunDir = writeSourceRun(rows);
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts(sourceRunDir, { spawner });

  await runFollowUp(opts);

  const control = readRawRows(opts.runDir).find((r) => r.followUp?.control === true);
  assert.deepEqual(control?.followUp, { sourceRun: SOURCE_RUN_NAME, sourceRepetition: null, control: true });
});

function writeExistingFollowUpRow(runDir: string, row: Partial<RawRow>): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "raw.jsonl"), `${JSON.stringify(row)}\n`);
}

test("runFollowUp_resumes_by_skipping_an_earlierResult_item_already_present_in_raw_jsonl", async () => {
  const rows = [sourceRow({ treatmentId: "rails-default", repetition: 1, files: { "parse_flags.ts": MUTATED_FLAG_PARSER } })];
  const sourceRunDir = writeSourceRun(rows);
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts(sourceRunDir, { spawner });
  writeExistingFollowUpRow(opts.runDir, {
    caseId: "ts-flag-parser",
    treatmentId: "rails-default",
    repetition: 1,
    followUp: { sourceRun: SOURCE_RUN_NAME, sourceRepetition: 1, control: false },
  });

  const result = await runFollowUp(opts);

  assert.equal(result.rowsWritten, 1);
  assert.equal(result.rowsSkipped, 1);
});

test("runFollowUp_does_not_confuse_a_control_item_with_an_earlierResult_item_at_the_same_repetition_when_resuming", async () => {
  const rows = [sourceRow({ treatmentId: "rails-default", repetition: 1, files: { "parse_flags.ts": MUTATED_FLAG_PARSER } })];
  const sourceRunDir = writeSourceRun(rows);
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts(sourceRunDir, { spawner });
  writeExistingFollowUpRow(opts.runDir, {
    caseId: "ts-flag-parser",
    treatmentId: "rails-default",
    repetition: 1,
    followUp: { sourceRun: SOURCE_RUN_NAME, sourceRepetition: null, control: true },
  });

  const result = await runFollowUp(opts);

  assert.equal(result.rowsWritten, 1);
  assert.equal(result.rowsSkipped, 1);
});

function assertSucceededWithModelMismatchWarning(result: { status: number; stderr: string }, sourceModel: string, requestedModel: string): void {
  assert.equal(result.status, 0);
  assert.match(result.stderr, new RegExp(`${sourceModel}.*${requestedModel}|${requestedModel}.*${sourceModel}`, "s"));
}

test("runFollowUp_warns_but_does_not_fail_when_model_differs_from_the_source_runs_provenance_model", async () => {
  const rows = [sourceRow({ files: { "parse_flags.ts": MUTATED_FLAG_PARSER }, provenance: baseProvenance({ model: "anthropic/claude-old" }) })];
  const sourceRunDir = writeSourceRun(rows);
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts(sourceRunDir, { spawner, model: "anthropic/claude-new" });

  const result = await runFollowUp(opts);

  assertSucceededWithModelMismatchWarning(result, "anthropic/claude-old", "anthropic/claude-new");
});

test("runFollowUp_refuses_to_write_into_the_source_run_directory", async () => {
  const rows = [sourceRow({ files: { "parse_flags.ts": MUTATED_FLAG_PARSER } })];
  const sourceRunDir = writeSourceRun(rows);
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts(sourceRunDir, { spawner, runDir: sourceRunDir });

  const result = await runFollowUp(opts);

  assert.equal(result.status, 1);
  assert.equal(calls.length, 0);
});

test("runFollowUp_reports_status_1_and_nothing_spawned_when_no_case_in_the_filter_has_an_extension", async () => {
  const rows = [sourceRow({ caseId: "ts-order-validator", files: {} })];
  const sourceRunDir = writeSourceRun(rows);
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts(sourceRunDir, { spawner, cases: ["ts-order-validator"] });

  const result = await runFollowUp(opts);

  assert.equal(result.status, 1);
  assert.equal(calls.length, 0);
});
