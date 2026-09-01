import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCollect, detectAgentError, countTurns, sumTokenUsage, countRailFirings, countShadowFirings, readDelivered } from "./collect.ts";
import type { CollectOpts } from "./collect.ts";
import type { RunSpec, RunOutcome, PiSpawner, ProbeOutcome, ProbeSpawner } from "./spawner.ts";
import { gitSha } from "./provenance.ts";
import { RULE, packHash, EVAL_ABORT_EXIT_CODE } from "../contract.ts";
import { CC_DELTA_NUDGE, CC_NUDGE, formatCcNudge } from "../messages.ts";
import { DEFAULT_POLICY } from "../policy.ts";
import { PROBE_FIXTURES } from "../delivery-probe.ts";
import type { ProbeReport } from "./canary.ts";
import { validatePack } from "./phrasing.ts";
import { SNAPSHOT_FILE_CAP_BYTES } from "./snapshot.ts";
import type { RawRow, Tier } from "./eval-contract.ts";

function passingProbeSpawner(): ProbeSpawner {
  return async (spec) => {
    const packContent = spec.env.LIUBAI_PHRASING_PACK;
    const validated = packContent === undefined ? undefined : validatePack(packContent);
    const pack = validated !== undefined && "pack" in validated ? validated.pack : {};

    const nudges: Partial<Record<"python" | "typescript", string[]>> = {};
    for (const fixture of PROBE_FIXTURES) {
      const entry = pack.CC_NUDGE?.[fixture.lang] ?? CC_NUDGE[fixture.lang];
      const threshold = DEFAULT_POLICY[RULE.cc].threshold?.[fixture.lang] ?? 8;
      nudges[fixture.lang] = [formatCcNudge(entry.first, { name: fixture.functionName, cc: fixture.cyclomaticComplexity, threshold })];
    }

    const report: ProbeReport = {
      packHash: packHash(packContent ?? null),
      nudges,
      errors: [],
      ccNudge: {
        python: pack.CC_NUDGE?.python ?? CC_NUDGE.python,
        typescript: pack.CC_NUDGE?.typescript ?? CC_NUDGE.typescript,
        cpp: pack.CC_NUDGE?.cpp ?? CC_NUDGE.cpp,
      },
      ccDeltaNudge: pack.CC_DELTA_NUDGE ?? CC_DELTA_NUDGE,
    };

    return { exitCode: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "" };
  };
}

function failingProbeSpawner(outcome: Partial<ProbeOutcome> = {}): ProbeSpawner {
  return async () => ({ exitCode: 1, stdout: "", stderr: "delivery probe crashed", ...outcome });
}

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CORPUS_DIR = join(import.meta.dirname, "corpus");

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
    probeSpawner: passingProbeSpawner(),
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

function binaryFilesUnderDirSpawner(dirName: string, filenames: string[]): PiSpawner {
  return async (spec) => {
    const dirPath = join(spec.cwd, dirName);
    mkdirSync(dirPath, { recursive: true });
    for (const filename of filenames) {
      writeFileSync(join(dirPath, filename), Buffer.from([0, 1, 2]));
    }
    return { exitCode: 0, stdoutJsonl: "", timedOut: false };
  };
}

function deletingSpawner(filename: string): PiSpawner {
  return async (spec) => {
    rmSync(join(spec.cwd, filename));
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
  writeFileSync(join(dir, "packs", "pack.json"), '{"CC_NUDGE":{"typescript":{"first":"advice","rest":"advice"}}}');
  writeFileSync(join(dir, "packed.json"), JSON.stringify({ id: "packed", env: {}, phrasingPack: "packs/pack.json" }));
  return dir;
}

const PROMPT_ARM_MESSAGE = "Complexity moved, it did not leave.";

function tempPromptConditionsDir(): string {
  const dir = tempDir("eval-conditions-");
  mkdirSync(join(dir, "packs"), { recursive: true });
  writeFileSync(join(dir, "packs", "pack.json"), JSON.stringify({ CC_DELTA_NUDGE: PROMPT_ARM_MESSAGE }));
  writeFileSync(
    join(dir, "prompt-carried.json"),
    JSON.stringify({ id: "prompt-carried", delivery: "prompt", env: { LIUBAI_RAILS_OFF: "1" }, phrasingPack: "packs/pack.json" }),
  );
  return dir;
}

function readCaseTask(corpusDir: string, caseId: string): string {
  const manifest = JSON.parse(readFileSync(join(corpusDir, caseId, "manifest.json"), "utf8")) as { task: string };
  return manifest.task;
}

function writeMinimalCase(corpusDir: string, id: string, tier: Tier, genuineDpMax?: number): void {
  const caseDir = join(corpusDir, id);
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(
    join(caseDir, "manifest.json"),
    JSON.stringify({
      id,
      lang: "typescript",
      files: ["thing.ts.case"],
      entry: "thing.ts",
      entrySymbol: "f",
      task: "Improve thing.ts. Keep the public function signature and behavior unchanged.",
      baseline: { decisionPoints: 1, functions: 1, silentHandlers: 0 },
      tier,
      ...(genuineDpMax !== undefined ? { genuineDpMax } : {}),
    }),
  );
  writeFileSync(join(caseDir, "probes.json"), JSON.stringify([{ args: [1], returns: 2 }]));
  const source = "export function f(x: number): number {\n  return x;\n}\n";
  writeFileSync(join(caseDir, "thing.ts.case"), source);
  if (tier === "hard") {
    const referenceDir = join(caseDir, "reference");
    mkdirSync(referenceDir, { recursive: true });
    writeFileSync(join(referenceDir, "thing.ts.case"), source);
  }
}

function twoTierCorpusDir(): string {
  const dir = tempDir("eval-corpus-");
  writeMinimalCase(dir, "case-easy", "easy");
  writeMinimalCase(dir, "case-hard", "hard", 0);
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

test("runCollect_passes_the_phrasing_pack_content_only_for_pack_conditions", async () => {
  const conditionsDir = tempPackedConditionsDir();
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["packed"], conditionsDir, spawner });

  await runCollect(opts);

  const packContent = readFileSync(join(conditionsDir, "packs", "pack.json"), "utf8");
  assert.equal(calls[0]?.env.LIUBAI_PHRASING_PACK, packContent);
});

test("runCollect_stamps_the_phrasing_pack_hash_from_the_content_delivered_to_the_agent", async () => {
  const conditionsDir = tempPackedConditionsDir();
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["packed"], conditionsDir, spawner });

  await runCollect(opts);

  const row = firstRow(opts.runDir);
  assert.equal(row.provenance.phrasingPackHash, packHash(calls[0]?.env.LIUBAI_PHRASING_PACK ?? null));
});

test("runCollect_omits_the_phrasing_pack_var_for_packless_conditions", async () => {
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal("LIUBAI_PHRASING_PACK" in (calls[0]?.env ?? {}), false);
});

test("runCollect_sends_the_case_task_followed_by_the_arm_message_for_a_prompt_delivery_condition", async () => {
  const conditionsDir = tempPromptConditionsDir();
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["prompt-carried"], conditionsDir, spawner });

  await runCollect(opts);

  const caseTask = readCaseTask(CORPUS_DIR, "ts-flag-parser");
  assert.equal(calls[0]?.task, `${caseTask}\n\n${PROMPT_ARM_MESSAGE}`);
});

const PROMPT_ARM_TEMPLATE_WITH_PLACEHOLDERS = "{name} still carries {dpBefore} decision points, unchanged from {dpAfter}.";

function tempPlaceholderPromptConditionsDir(): string {
  const dir = tempDir("eval-conditions-");
  mkdirSync(join(dir, "packs"), { recursive: true });
  writeFileSync(join(dir, "packs", "pack.json"), JSON.stringify({ CC_DELTA_NUDGE: PROMPT_ARM_TEMPLATE_WITH_PLACEHOLDERS }));
  writeFileSync(
    join(dir, "prompt-carried.json"),
    JSON.stringify({ id: "prompt-carried", delivery: "prompt", env: { LIUBAI_RAILS_OFF: "1" }, phrasingPack: "packs/pack.json" }),
  );
  return dir;
}

test("runCollect_fills_the_arm_messages_placeholders_with_the_cases_entry_symbol_and_decision_points", async () => {
  const conditionsDir = tempPlaceholderPromptConditionsDir();
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["prompt-carried"], conditionsDir, spawner });

  await runCollect(opts);

  const caseTask = readCaseTask(CORPUS_DIR, "ts-flag-parser");
  assert.equal(calls[0]?.task, `${caseTask}\n\nparseFlags still carries 24 decision points, unchanged from 24.`);
});

test("runCollect_records_the_sent_task_on_the_raw_row_for_a_prompt_delivery_condition", async () => {
  const conditionsDir = tempPromptConditionsDir();
  const { spawner } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["prompt-carried"], conditionsDir, spawner });

  await runCollect(opts);

  const caseTask = readCaseTask(CORPUS_DIR, "ts-flag-parser");
  assert.equal(firstRow(opts.runDir).task, `${caseTask}\n\n${PROMPT_ARM_MESSAGE}`);
});

test("runCollect_omits_task_from_the_raw_row_for_a_rail_delivery_condition", async () => {
  const { spawner } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal("task" in firstRow(opts.runDir), false);
});

function priorDraftContent(caseId: string, filename: string): string {
  return readFileSync(join(CORPUS_DIR, caseId, filename), "utf8");
}

function extensionTaskOf(caseId: string): string {
  const extension = JSON.parse(readFileSync(join(CORPUS_DIR, caseId, "extension.json"), "utf8")) as { task: string };
  return extension.task;
}

function assertSentTaskIsTheSimulatedSessionOpeningForTheCase(sentTask: string, caseId: string, draftFilename: string): void {
  assert.ok(sentTask.includes(priorDraftContent(caseId, draftFilename)), "sent task does not carry the prior draft");
  assert.ok(sentTask.includes(extensionTaskOf(caseId)), "sent task does not carry the extension task");
  assert.ok(!sentTask.includes(readCaseTask(CORPUS_DIR, caseId)), "sent task leaks the case's normal improve task");
}

test("runCollect_sends_the_simulated_session_opening_task_instead_of_the_cases_normal_task_when_simulated_session_mode_is_on", async () => {
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-telemetry-pipeline"], conditions: ["rails-default"], spawner, simulatedSession: true });

  const result = await runCollect(opts);

  assert.equal(result.status, 0);
  assertSentTaskIsTheSimulatedSessionOpeningForTheCase(calls[0]!.task, "ts-telemetry-pipeline", "prior-draft.ts");
});

test("runCollect_fails_fast_without_spawning_when_simulated_session_mode_is_on_and_a_selected_case_has_no_prior_draft", async () => {
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner, simulatedSession: true });

  const result = await runCollect(opts);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ts-flag-parser/);
  assert.equal(calls.length, 0);
});

test("runCollect_fails_fast_without_spawning_when_simulated_session_mode_is_on_and_a_selected_condition_delivers_by_prompt", async () => {
  const conditionsDir = tempPromptConditionsDir();
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-telemetry-pipeline"], conditions: ["prompt-carried"], conditionsDir, spawner, simulatedSession: true });

  const result = await runCollect(opts);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /prompt-carried/);
  assert.equal(calls.length, 0);
});

test("runCollect_always_sets_LIUBAI_EVAL_so_the_spawned_agent_sandboxes_its_bash_tool", async () => {
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal(calls[0]?.env.LIUBAI_EVAL, "1");
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

test("detectAgentError_reports_a_crash_that_exited_nonzero_before_any_assistant_response", () => {
  const stdoutJsonl = `${JSON.stringify({ type: "session", version: 3 })}\n`;

  const agentError = detectAgentError(stdoutJsonl, 1);

  assert.equal(agentError, "agent exited 1 before any assistant response");
});

test("detectAgentError_labels_a_nonzero_exit_that_produced_assistant_responses", () => {
  const stdoutJsonl = messageEndLine("stop");

  const agentError = detectAgentError(stdoutJsonl, 1);

  assert.match(agentError ?? "", /agent exited 1 after a partial run/);
});

test("detectAgentError_flags_exit_17_with_assistant_responses_as_rail_abort", () => {
  const stdoutJsonl = messageEndLine("stop");

  const agentError = detectAgentError(stdoutJsonl, 17);

  assert.match(agentError ?? "", /rail aborted.*exit 17/);
});

test("detectAgentError_flags_other_nonzero_exit_codes_with_assistant_responses", () => {
  const stdoutJsonl = messageEndLine("stop");

  const agentError = detectAgentError(stdoutJsonl, 3);

  assert.match(agentError ?? "", /agent exited 3 after a partial run/);
});

test("detectAgentError_still_returns_undefined_for_exit_0_with_assistant_responses_and_clean_stop", () => {
  const stdoutJsonl = messageEndLine("stop");

  const agentError = detectAgentError(stdoutJsonl, 0);

  assert.equal(agentError, undefined);
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

function turnStartLine(): string {
  return `${JSON.stringify({ type: "turn_start" })}\n`;
}

test("countTurns_counts_one_turn_per_turn_start_event", () => {
  const stdoutJsonl = turnStartLine() + turnStartLine() + turnStartLine();

  assert.equal(countTurns(stdoutJsonl), 3);
});

test("countTurns_returns_zero_for_a_session_with_no_completed_turns", () => {
  assert.equal(countTurns(""), 0);
});

function assistantMessageEndLine(usage: Partial<{ input: number; output: number; cacheRead: number }> = {}): string {
  const message = { role: "assistant", usage: { input: 0, output: 0, cacheRead: 0, ...usage } };
  return `${JSON.stringify({ type: "message_end", message })}\n`;
}

test("sumTokenUsage_sums_input_and_output_tokens_across_every_assistant_message", () => {
  const stdoutJsonl = assistantMessageEndLine({ input: 100, output: 20 }) + assistantMessageEndLine({ input: 150, output: 40 });

  const usage = sumTokenUsage(stdoutJsonl);

  assert.equal(usage.tokensIn, 250);
  assert.equal(usage.tokensOut, 60);
});

test("sumTokenUsage_sums_cache_read_tokens_across_every_assistant_message", () => {
  const stdoutJsonl = assistantMessageEndLine({ cacheRead: 30 }) + assistantMessageEndLine({ cacheRead: 12 });

  assert.equal(sumTokenUsage(stdoutJsonl).cacheReadTokens, 42);
});

test("sumTokenUsage_ignores_messages_that_are_not_from_the_assistant", () => {
  const stdoutJsonl = messageEndLine("stop", undefined, "user") + assistantMessageEndLine({ input: 10, output: 5 });

  const usage = sumTokenUsage(stdoutJsonl);

  assert.equal(usage.tokensIn, 10);
  assert.equal(usage.tokensOut, 5);
});

function assertZeroUsage(usage: { tokensIn: number; tokensOut: number; cacheReadTokens: number }): void {
  assert.deepEqual(usage, { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 });
}

test("sumTokenUsage_reports_zero_for_a_session_with_no_assistant_messages", () => {
  assertZeroUsage(sumTokenUsage(""));
});

function toolExecutionEndLine(texts: string[], isError = false): string {
  const result = { content: texts.map((text) => ({ type: "text", text })) };
  return `${JSON.stringify({ type: "tool_execution_end", toolCallId: "1", toolName: "edit", result, isError })}\n`;
}

test("countRailFirings_counts_a_bracketed_rule_tag_appended_to_a_tool_result", () => {
  const stdoutJsonl = toolExecutionEndLine(["Successfully replaced 1 block(s).", "\n\n[cc] f (CC=10). too complex."]);

  assert.equal(countRailFirings(stdoutJsonl).cc, 1);
});

test("countRailFirings_counts_a_blocked_result_as_a_firing_of_its_rule", () => {
  const stdoutJsonl = toolExecutionEndLine(["[discourage-comments] Blocked: new comments detected"], true);

  assert.equal(countRailFirings(stdoutJsonl)["discourage-comments"], 1);
});

test("countRailFirings_sums_firings_of_the_same_rule_across_separate_tool_calls", () => {
  const stdoutJsonl = toolExecutionEndLine(["\n\n[cc] a (CC=9)."]) + toolExecutionEndLine(["\n\n[cc] a (CC=9)."]);

  assert.equal(countRailFirings(stdoutJsonl).cc, 2);
});

test("countRailFirings_counts_each_rule_independently_when_several_fire_on_one_tool_call", () => {
  const stdoutJsonl = toolExecutionEndLine(["\n\n[cc] a (CC=9).\n\n[type-annotation] missing return type."]);

  const firings = countRailFirings(stdoutJsonl);

  assert.equal(firings.cc, 1);
  assert.equal(firings["type-annotation"], 1);
});

test("countRailFirings_reports_zero_for_a_rule_that_never_fired", () => {
  const firings = countRailFirings("");

  assert.equal(firings["test-linearity"], 0);
});

function shadowLogLine(rule: string, path: string): string {
  return `${JSON.stringify({ ts: "2026-08-30T00:00:00.000Z", rule, path })}\n`;
}

test("countShadowFirings_counts_a_shadowed_rule_firing_once", () => {
  const log = shadowLogLine("cc-delta", "a.py");

  assert.equal(countShadowFirings(log)["cc-delta"], 1);
});

test("countShadowFirings_sums_firings_of_the_same_rule_across_lines", () => {
  const log = shadowLogLine("cc-delta", "a.py") + shadowLogLine("cc-delta", "b.py");

  assert.equal(countShadowFirings(log)["cc-delta"], 2);
});

test("countShadowFirings_ignores_a_rule_name_the_engine_does_not_know", () => {
  const log = shadowLogLine("not-a-real-rule", "a.py");

  const firings = countShadowFirings(log);

  assert.equal(firings.cc, 0);
  assert.equal(firings["cc-delta"], 0);
});

test("countShadowFirings_skips_a_malformed_line_without_losing_the_valid_ones", () => {
  const log = "{ not json\n" + shadowLogLine("cc-delta", "a.py");

  assert.equal(countShadowFirings(log)["cc-delta"], 1);
});

test("countShadowFirings_reports_zero_for_an_empty_log", () => {
  assert.equal(countShadowFirings("")["cc-delta"], 0);
});

function assertCostMetricsStamped(row: RawRow): void {
  assert.equal(row.turns, 2);
  assert.equal(row.tokensIn, 100);
  assert.equal(row.tokensOut, 20);
  assert.equal(row.railFirings?.cc, 1);
  assert.equal(row.railFirings?.["discourage-comments"], 0);
}

test("runCollect_stamps_turns_tokens_and_rail_firings_from_stdout_onto_the_raw_row", async () => {
  const stdoutJsonl =
    turnStartLine() +
    turnStartLine() +
    assistantMessageEndLine({ input: 100, output: 20 }) +
    toolExecutionEndLine(["\n\n[cc] f (CC=9)."]);
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl, timedOut: false });
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assertCostMetricsStamped(firstRow(opts.runDir));
});

test("runCollect_stamps_the_death_signal_and_stderr_tail_of_a_killed_rep_onto_the_raw_row", async () => {
  const spawner = fixedOutcomeSpawner({ exitCode: -1, stdoutJsonl: "", timedOut: false, signal: "SIGKILL", stderrTail: "gateway stream reset" });
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal(firstRow(opts.runDir).signal, "SIGKILL");
  assert.equal(firstRow(opts.runDir).stderrTail, "gateway stream reset");
});

function shadowLogSpawner(lines: string[]): PiSpawner {
  return async (spec) => {
    const shadowDir = join(spec.cwd, ".liubai");
    mkdirSync(shadowDir, { recursive: true });
    writeFileSync(join(shadowDir, "shadow.jsonl"), lines.join(""));
    return { exitCode: 0, stdoutJsonl: "", timedOut: false };
  };
}

test("runCollect_stamps_shadowFirings_from_the_workdirs_shadow_log_onto_the_raw_row", async () => {
  const spawner = shadowLogSpawner([shadowLogLine("cc-delta", "a.py"), shadowLogLine("cc-delta", "b.py")]);
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal(firstRow(opts.runDir).shadowFirings?.["cc-delta"], 2);
});

test("runCollect_omits_shadowFirings_from_the_raw_row_when_no_shadow_log_was_written", async () => {
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal(firstRow(opts.runDir).shadowFirings, undefined);
});

function deliveredStampSpawner(delivered: unknown): PiSpawner {
  return async (spec) => {
    const liubaiDir = join(spec.cwd, ".liubai");
    mkdirSync(liubaiDir, { recursive: true });
    writeFileSync(join(liubaiDir, "delivered.json"), JSON.stringify(delivered));
    return { exitCode: 0, stdoutJsonl: "", timedOut: false };
  };
}

test("readDelivered_parses_the_workdirs_delivered_stamp", () => {
  const workDir = tempDir("eval-delivered-");
  mkdirSync(join(workDir, ".liubai"), { recursive: true });
  const delivered = { packHash: "abc123", liveRules: ["cc"], shadowRules: [] };
  writeFileSync(join(workDir, ".liubai", "delivered.json"), JSON.stringify(delivered));

  assert.deepEqual(readDelivered(workDir), delivered);
});

test("readDelivered_is_undefined_when_no_stamp_was_written", () => {
  const workDir = tempDir("eval-delivered-");

  assert.equal(readDelivered(workDir), undefined);
});

test("readDelivered_is_undefined_when_the_stamp_is_unparseable_json", () => {
  const workDir = tempDir("eval-delivered-");
  mkdirSync(join(workDir, ".liubai"), { recursive: true });
  writeFileSync(join(workDir, ".liubai", "delivered.json"), "{ not json");

  assert.equal(readDelivered(workDir), undefined);
});

test("runCollect_stamps_delivered_from_the_workdirs_delivered_json_onto_the_raw_row", async () => {
  const delivered = { packHash: null, liveRules: ["cc", "cc-delta"], shadowRules: [] };
  const spawner = deliveredStampSpawner(delivered);
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.deepEqual(firstRow(opts.runDir).delivered, delivered);
});

test("runCollect_omits_delivered_from_the_raw_row_when_no_delivered_stamp_was_written", async () => {
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal(firstRow(opts.runDir).delivered, undefined);
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

test("runCollect_runs_no_work_items_and_reports_a_load_error_when_the_delivery_canary_fails", async () => {
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({
    cases: ["ts-flag-parser"],
    conditions: ["control", "rails-default"],
    spawner,
    probeSpawner: failingProbeSpawner({ stderr: "python rail dead inside the sandbox" }),
  });

  const result = await runCollect(opts);

  assert.equal(result.status, 1);
  assert.equal(calls.length, 0);
  assert.equal(result.rowsWritten, 0);
  assert.match(result.stderr, /control|rails-default/);
  assert.match(result.stderr, /python rail dead inside the sandbox/);
});

test("runCollect_probes_every_condition_in_the_run_before_dispatching_any_work_item", async () => {
  const probeCwds: string[] = [];
  const probeSpawner: ProbeSpawner = async (spec) => {
    probeCwds.push(spec.cwd);
    return passingProbeSpawner()(spec);
  };
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control", "rails-default"], spawner, probeSpawner });

  await runCollect(opts);

  assert.equal(probeCwds.length, 2);
  assert.equal(calls.length, 2);
});

test("runCollect_writes_a_canary_json_report_naming_every_probed_condition", async () => {
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control", "rails-default"], spawner: recordingSpawner().spawner });

  await runCollect(opts);

  const canary = JSON.parse(readFileSync(join(opts.runDir, "canary.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(canary).sort(), ["control", "rails-default"]);
});

test("runCollect_rejects_a_non_positive_parallel_value_with_a_load_error", async () => {
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner, parallel: 0 });

  const result = await runCollect(opts);

  assert.equal(result.status, 1);
  assert.equal(calls.length, 0);
  assert.match(result.stderr, /parallel/);
});

function assertOnlyCasesRan(runDir: string, expectedCaseIds: string[]): void {
  assert.deepEqual(readRawRows(runDir).map((row) => row.caseId), expectedCaseIds);
}

test("runCollect_keeps_only_cases_matching_the_tier_filter", async () => {
  const corpusDir = twoTierCorpusDir();
  const { spawner } = recordingSpawner();
  const opts = baseOpts({ corpusDir, conditions: ["control"], tier: "easy", spawner });

  const result = await runCollect(opts);

  assertRawRowCounts(result, 1, 0);
  assertOnlyCasesRan(opts.runDir, ["case-easy"]);
});

test("runCollect_reports_a_load_error_when_the_tier_filter_matches_no_cases", async () => {
  const { spawner, calls } = recordingSpawner();
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], tier: "hard", spawner });

  const result = await runCollect(opts);

  assert.equal(result.status, 1);
  assert.equal(calls.length, 0);
  assert.match(result.stderr, /no cases with tier: hard/);
});

function assertBothDeclaredAndExtraFileCaptured(files: Record<string, string>, extraFilename: string, extraContent: string): void {
  assert.equal("parse_flags.ts" in files, true);
  assert.equal(files[extraFilename], extraContent);
}

test("runCollect_captures_files_the_agent_created_beside_the_declared_ones", async () => {
  const helperSource = "export function helper() { return 1; }\n";
  const spawner = mutatingSpawner("helpers.ts", helperSource);
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assertBothDeclaredAndExtraFileCaptured(firstRow(opts.runDir).files, "helpers.ts", helperSource);
});

test("runCollect_records_dropped_extras_in_snapshotDropped_at_directory_granularity", async () => {
  const spawner = binaryFilesUnderDirSpawner("junk", ["a.bin", "b.bin"]);
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.deepEqual(firstRow(opts.runDir).snapshotDropped, ["junk/"]);
});

test("runCollect_leaves_snapshotDropped_absent_when_nothing_is_dropped", async () => {
  const spawner = fixedOutcomeSpawner({ exitCode: 0, stdoutJsonl: "", timedOut: false });
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal("snapshotDropped" in firstRow(opts.runDir), false);
});

test("runCollect_captures_a_declared_file_whole_even_past_the_extra_file_cap", async () => {
  const oversizedSource = "a".repeat(SNAPSHOT_FILE_CAP_BYTES + 1);
  const spawner = mutatingSpawner("parse_flags.ts", oversizedSource);
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal(firstRow(opts.runDir).files["parse_flags.ts"], oversizedSource);
});

test("runCollect_omits_a_declared_file_the_agent_deleted", async () => {
  const spawner = deletingSpawner("parse_flags.ts");
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  assert.equal("parse_flags.ts" in firstRow(opts.runDir).files, false);
});

test("runCollect_records_rail_abort_as_agentError_when_exit_code_is_17_with_completed_assistant_messages", async () => {
  const stdoutJsonl = messageEndLine("stop");
  const spawner = fixedOutcomeSpawner({ exitCode: EVAL_ABORT_EXIT_CODE, stdoutJsonl, timedOut: false });
  const opts = baseOpts({ cases: ["ts-flag-parser"], conditions: ["control"], spawner });

  await runCollect(opts);

  const row = firstRow(opts.runDir);
  assert.ok(row.agentError, "expected agentError to be set");
  assert.match(row.agentError, /rail aborted.*exit 17/);
});
