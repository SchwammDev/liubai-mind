import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCollect, detectAgentError } from "./collect.ts";
import type { CollectOpts } from "./collect.ts";
import type { RunSpec, RunOutcome, PiSpawner } from "./spawner.ts";
import { gitSha } from "./provenance.ts";
import type { RawRow } from "./eval-contract.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const EXPECTED_FOUR_PAIRS = [
  "ts-flag-parser/control/1",
  "ts-flag-parser/rails-default/1",
  "ts-order-validator/control/1",
  "ts-order-validator/rails-default/1",
];

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseOpts(over: Partial<CollectOpts> = {}): CollectOpts {
  return {
    repoRoot: REPO_ROOT,
    runDir: tempDir("eval-run-"),
    workRoot: tempDir("eval-work-"),
    reps: 1,
    model: "claude-test-model",
    ...over,
  };
}

function twoCaseTwoConditionOpts(spawner: PiSpawner): CollectOpts {
  return baseOpts({ cases: ["ts-flag-parser", "ts-order-validator"], conditions: ["control", "rails-default"], spawner });
}

function readRawRows(runDir: string): RawRow[] {
  const raw = readFileSync(join(runDir, "raw.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RawRow);
}

function firstRow(runDir: string): RawRow {
  const [row] = readRawRows(runDir);
  assert.ok(row, "expected at least one raw row");
  return row;
}

function pairKey(row: RawRow): string {
  return `${row.caseId}/${row.conditionId}/${row.rep}`;
}

function assertRawRowCounts(result: { rowsWritten: number; rowsSkipped: number }, written: number, skipped: number): void {
  assert.equal(result.rowsWritten, written);
  assert.equal(result.rowsSkipped, skipped);
}

function assertNoDuplicateKeys(rows: RawRow[]): void {
  const keys = rows.map(pairKey);
  assert.equal(new Set(keys).size, keys.length);
}

function assertResumedRawFileHasAllFourRowsWithoutDuplicates(runDir: string): void {
  const rows = readRawRows(runDir);
  assert.equal(rows.length, 4);
  assertNoDuplicateKeys(rows);
}

function writeExistingRawRow(runDir: string, row: Partial<RawRow>): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "raw.jsonl"), `${JSON.stringify(row)}\n`);
}

function mutateEveryFile(cwd: string): void {
  for (const filename of readdirSync(cwd)) {
    appendFileSync(join(cwd, filename), "\n// mutated\n");
  }
}

function recordingSpawner(mutate: (spec: RunSpec) => void = () => {}): { spawner: PiSpawner; calls: RunSpec[] } {
  const calls: RunSpec[] = [];
  const spawner: PiSpawner = async (spec) => {
    calls.push(spec);
    mutate(spec);
    return { exitCode: 0, stdoutJsonl: '{"ok":true}\n', timedOut: false };
  };
  return { spawner, calls };
}

function recordingListingSpawner(): { spawner: PiSpawner; listings: string[][]; cwds: string[] } {
  const listings: string[][] = [];
  const cwds: string[] = [];
  const { spawner } = recordingSpawner((spec) => {
    listings.push(readdirSync(spec.cwd));
    cwds.push(spec.cwd);
  });
  return { spawner, listings, cwds };
}

function fixedOutcomeSpawner(outcome: RunOutcome): PiSpawner {
  return async () => outcome;
}

function mutatingSpawner(filename: string, content: string): PiSpawner {
  return async (spec) => {
    writeFileSync(join(spec.cwd, filename), content);
    return { exitCode: 0, stdoutJsonl: "", timedOut: false };
  };
}

function parallelOpts(cases: string[], conditions: string[], spawner: PiSpawner, parallel: number): CollectOpts {
  return baseOpts({ cases, conditions, spawner, parallel });
}

function assertPartialFailureReportsStatusOne(result: { status: number; rowsWritten: number; stderr: string }, written: number): void {
  assert.equal(result.status, 1);
  assert.equal(result.rowsWritten, written);
  assert.match(result.stderr, /boom/);
}

function trackingConcurrencySpawner(): { spawner: PiSpawner; maxInFlight: () => number } {
  let inFlight = 0;
  let max = 0;
  let seq = 0;
  const spawner: PiSpawner = async () => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    const delayMs = seq % 2 === 0 ? 15 : 5;
    seq += 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    inFlight -= 1;
    return { exitCode: 0, stdoutJsonl: "", timedOut: false };
  };
  return { spawner, maxInFlight: () => max };
}

function rejectFirstThenMutate(): PiSpawner {
  let calls = 0;
  return async (spec) => {
    calls += 1;
    if (calls === 1) throw new Error("boom");
    mutateEveryFile(spec.cwd);
    return { exitCode: 0, stdoutJsonl: "", timedOut: false };
  };
}

function tempPackedConditionsDir(): string {
  const dir = tempDir("eval-conditions-");
  mkdirSync(join(dir, "packs"), { recursive: true });
  writeFileSync(join(dir, "packs", "pack.json"), '{"CC_ADVICE":{"typescript":"advice"}}');
  writeFileSync(join(dir, "packed.json"), JSON.stringify({ id: "packed", env: {}, phrasingPack: "packs/pack.json" }));
  return dir;
}

function assertProvenanceStamped(row: RawRow, now: string): void {
  assert.equal(row.provenance.conditionId, "control");
  assert.equal(row.provenance.phrasingPackHash, null);
  assert.equal(row.provenance.model, "claude-test-model");
  assert.equal(row.provenance.collectedAt, now);
  assert.equal(row.provenance.liubaiSha, gitSha(REPO_ROOT));
}

test("runCollect_writes_one_raw_row_per_case_condition_rep", async () => {
  const { spawner } = recordingSpawner((spec) => mutateEveryFile(spec.cwd));
  const opts = twoCaseTwoConditionOpts(spawner);

  const result = await runCollect(opts);

  assertRawRowCounts(result, 4, 0);
  assert.deepEqual(readRawRows(opts.runDir).map(pairKey).sort(), EXPECTED_FOUR_PAIRS);
});

test("runCollect_resumes_by_skipping_keys_already_present_in_raw_jsonl", async () => {
  const { spawner } = recordingSpawner((spec) => mutateEveryFile(spec.cwd));
  const opts = twoCaseTwoConditionOpts(spawner);
  writeExistingRawRow(opts.runDir, { caseId: "ts-flag-parser", conditionId: "control", rep: 1 });

  const result = await runCollect(opts);

  assertRawRowCounts(result, 3, 1);
  assertResumedRawFileHasAllFourRowsWithoutDuplicates(opts.runDir);
});

test("runCollect_copies_case_files_with_case_suffix_stripped_into_a_fresh_workdir", async () => {
  const { spawner, listings, cwds } = recordingListingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control", "rails-default"], spawner });

  await runCollect(opts);

  assert.deepEqual(listings[0], ["parse_flags.ts"]);
  assert.equal(new Set(cwds).size, 2);
});

test("runCollect_passes_control_condition_env_to_the_spawner", async () => {
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal(calls[0]?.env.LIUBAI_RAILS_OFF, "1");
});

test("runCollect_passes_the_phrasing_pack_path_only_for_pack_conditions", async () => {
  const conditionsDir = tempPackedConditionsDir();
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["packed"], conditionsDir, spawner });

  await runCollect(opts);

  assert.equal(calls[0]?.env.LIUBAI_PHRASING_PACK, join(conditionsDir, "packs", "pack.json"));
});

test("runCollect_omits_the_phrasing_pack_var_for_packless_conditions", async () => {
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal("LIUBAI_PHRASING_PACK" in (calls[0]?.env ?? {}), false);
});

test("runCollect_records_the_exit_code_and_timedOut_flag_from_the_spawner_outcome", async () => {
  const spawner = fixedOutcomeSpawner({ exitCode: 7, stdoutJsonl: "", timedOut: true });
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  const row = firstRow(opts.runDir);
  assert.equal(row.exitCode, 7);
  assert.equal(row.timedOut, true);
});

test("runCollect_captures_final_file_state_from_disk_after_the_spawner_mutates_it", async () => {
  const mutatedSource = "export function parseFlags() { return 1; }\n";
  const spawner = mutatingSpawner("parse_flags.ts", mutatedSource);
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal(firstRow(opts.runDir).files["parse_flags.ts"], mutatedSource);
});

test("runCollect_stores_the_spawner_stdout_jsonl_under_transcripts", async () => {
  const stdoutJsonl = '{"event":"done"}\n';
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl, timedOut: false });
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  const transcriptPath = join(opts.runDir, "transcripts", "ts-flag-parser.control.1.jsonl");
  assert.equal(readFileSync(transcriptPath, "utf8"), stdoutJsonl);
});

test("runCollect_stamps_provenance_with_condition_git_sha_model_and_injected_now", async () => {
  const now = () => "2026-01-01T00:00:00.000Z";
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner, now });

  await runCollect(opts);

  assertProvenanceStamped(firstRow(opts.runDir), now());
});

test("runCollect_continues_past_a_rejecting_spawner_and_reports_status_1", async () => {
  const spawner = rejectFirstThenMutate();
  const opts = baseOpts({ cases: ["ts-flag-parser", "ts-order-validator"], conditions: ["control"], spawner });

  const result = await runCollect(opts);

  assertPartialFailureReportsStatusOne(result, 1);
});

test("runCollect_reports_status_1_and_nothing_spawned_on_a_load_error", async () => {
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ conditions: ["nonexistent"], spawner });

  const result = await runCollect(opts);

  assert.equal(result.status, 1);
  assert.equal(calls.length, 0);
  assert.match(result.stderr, /nonexistent/);
});

test("runCollect_bounds_the_worker_pool_to_the_parallel_limit", async () => {
  const { spawner, maxInFlight } = trackingConcurrencySpawner();
  const opts = parallelOpts(["ts-flag-parser", "ts-order-validator", "py-ingest-bait"], ["control", "rails-default"], spawner, 2);

  const result = await runCollect(opts);

  assertRawRowCounts(result, 6, 0);
  assert.equal(maxInFlight(), 2);
});

test("runCollect_defaults_to_sequential_execution_when_parallel_is_omitted", async () => {
  const { spawner, maxInFlight } = trackingConcurrencySpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser", "ts-order-validator"], conditions: ["control", "rails-default"], spawner });

  await runCollect(opts);

  assert.equal(maxInFlight(), 1);
});

test("runCollect_writes_every_row_when_running_with_parallel_greater_than_one", async () => {
  const { spawner } = recordingSpawner((spec) => mutateEveryFile(spec.cwd));
  const opts = parallelOpts(["ts-flag-parser", "ts-order-validator"], ["control", "rails-default"], spawner, 3);

  const result = await runCollect(opts);

  assertRawRowCounts(result, 4, 0);
  assert.deepEqual(readRawRows(opts.runDir).map(pairKey).sort(), EXPECTED_FOUR_PAIRS);
});

test("runCollect_resumes_by_skipping_keys_already_present_in_raw_jsonl_with_parallel_greater_than_one", async () => {
  const { spawner } = recordingSpawner((spec) => mutateEveryFile(spec.cwd));
  const opts = parallelOpts(["ts-flag-parser", "ts-order-validator"], ["control", "rails-default"], spawner, 2);
  writeExistingRawRow(opts.runDir, { caseId: "ts-flag-parser", conditionId: "control", rep: 1 });

  const result = await runCollect(opts);

  assertRawRowCounts(result, 3, 1);
  assertResumedRawFileHasAllFourRowsWithoutDuplicates(opts.runDir);
});

test("runCollect_lets_other_items_finish_when_one_spawner_call_rejects_under_parallelism", async () => {
  const spawner = rejectFirstThenMutate();
  const opts = parallelOpts(["ts-flag-parser", "ts-order-validator", "py-ingest-bait"], ["control"], spawner, 2);

  const result = await runCollect(opts);

  assertPartialFailureReportsStatusOne(result, 2);
});

function autoRetryEndLine(overrides: Partial<{ success: boolean; finalError: string; attempt: number }> = {}): string {
  return `${JSON.stringify({ type: "auto_retry_end", success: true, attempt: 1, ...overrides })}\n`;
}

test("detectAgentError_returns_the_finalError_text_for_a_terminal_retry_failure", () => {
  const stdoutJsonl =
    autoRetryEndLine({ success: true }) +
    autoRetryEndLine({ success: false, attempt: 2, finalError: "OpenAI API error (404): model not found" });

  const agentError = detectAgentError(stdoutJsonl);

  assert.equal(agentError, "OpenAI API error (404): model not found");
});

test("detectAgentError_returns_undefined_when_every_auto_retry_end_event_succeeded", () => {
  const stdoutJsonl = autoRetryEndLine({ attempt: 1 }) + autoRetryEndLine({ attempt: 2 });

  const agentError = detectAgentError(stdoutJsonl);

  assert.equal(agentError, undefined);
});

function messageEndLine(stopReason: string, errorMessage?: string, role = "assistant"): string {
  const message = { role, stopReason, ...(errorMessage !== undefined ? { errorMessage } : {}) };
  return `${JSON.stringify({ type: "message_end", message })}\n`;
}

test("detectAgentError_reports_a_session_whose_last_assistant_message_ended_in_error", () => {
  const stdoutJsonl =
    messageEndLine("stop") +
    messageEndLine("error", "OpenAI API error (404): incompatible model") +
    `${JSON.stringify({ type: "agent_settled" })}\n`;

  const agentError = detectAgentError(stdoutJsonl);

  assert.equal(agentError, "OpenAI API error (404): incompatible model");
});

test("detectAgentError_ignores_a_transient_error_message_that_a_later_assistant_message_recovered_from", () => {
  const stdoutJsonl =
    messageEndLine("error", "ECONNRESET") +
    autoRetryEndLine({ success: true, attempt: 2 }) +
    messageEndLine("stop");

  const agentError = detectAgentError(stdoutJsonl);

  assert.equal(agentError, undefined);
});

test("detectAgentError_ignores_error_shaped_user_messages", () => {
  const stdoutJsonl = messageEndLine("error", "not from the assistant", "user") + messageEndLine("stop");

  const agentError = detectAgentError(stdoutJsonl);

  assert.equal(agentError, undefined);
});

test("detectAgentError_returns_undefined_for_empty_stdout", () => {
  assert.equal(detectAgentError(""), undefined);
});

test("detectAgentError_skips_unparseable_lines_and_returns_undefined_when_none_indicate_failure", () => {
  const stdoutJsonl = ["not json", "{also not json", autoRetryEndLine({ success: true })].join("\n");

  const agentError = detectAgentError(stdoutJsonl);

  assert.equal(agentError, undefined);
});

test("runCollect_stamps_agentError_into_the_raw_row_when_stdout_reports_a_terminal_retry_failure", async () => {
  const stdoutJsonl = autoRetryEndLine({ success: false, attempt: 2, finalError: "OpenAI API error (404): model not found" });
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl, timedOut: false });
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal(firstRow(opts.runDir).agentError, "OpenAI API error (404): model not found");
});

test("runCollect_leaves_agentError_absent_when_stdout_shows_only_successful_retries", async () => {
  const stdoutJsonl = autoRetryEndLine({ attempt: 1 });
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl, timedOut: false });
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal("agentError" in firstRow(opts.runDir), false);
});

test("runCollect_rejects_a_non_positive_parallel_value_with_a_load_error", async () => {
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner, parallel: 0 });

  const result = await runCollect(opts);

  assert.equal(result.status, 1);
  assert.equal(calls.length, 0);
  assert.match(result.stderr, /parallel/);
});
