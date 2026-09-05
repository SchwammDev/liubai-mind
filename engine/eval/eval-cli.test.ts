import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { parseCliArgs, runEval } from "./eval-cli.ts";
import type { ParsedCli } from "./eval-cli.ts";
import type { CollectOpts, CollectResult } from "./collect.ts";
import type { runScore } from "./score.ts";
import type { FollowUpOpts, FollowUpResult } from "./follow-up.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

type ScoreOpts = Parameters<typeof runScore>[0];
type ScoreResult = Awaited<ReturnType<typeof runScore>>;

function assertParsedCollect(parsed: ParsedCli, over: Partial<Extract<ParsedCli, { cmd: "collect" }>>): void {
  assert.deepEqual(parsed, {
    cmd: "collect",
    run: "baseline",
    model: "anthropic/claude-test",
    repetitions: 5,
    parallel: 1,
    ...over,
  });
}

function collectArgv(...extra: string[]): string[] {
  return ["collect", "--run", "baseline", "--model", "anthropic/claude-test", ...extra];
}

function repeated(flag: string, values: string[]): string[] {
  return values.flatMap((value) => [flag, value]);
}

function recordingCollect(result: CollectResult): { collect: (opts: CollectOpts) => Promise<CollectResult>; calls: CollectOpts[] } {
  const calls: CollectOpts[] = [];
  const collect = async (opts: CollectOpts): Promise<CollectResult> => {
    calls.push(opts);
    return result;
  };
  return { collect, calls };
}

function recordingScore(result: ScoreResult): { score: (opts: ScoreOpts) => Promise<ScoreResult>; calls: ScoreOpts[] } {
  const calls: ScoreOpts[] = [];
  const score = async (opts: ScoreOpts): Promise<ScoreResult> => {
    calls.push(opts);
    return result;
  };
  return { score, calls };
}

function throwingCollect(message: string): (opts: CollectOpts) => Promise<CollectResult> {
  return async () => {
    throw new Error(message);
  };
}

test("parseCliArgs_parses_a_full_collect_invocation", () => {
  const argv = collectArgv("--repetitions", "3", "--timeout-ms", "60000", ...repeated("--case", ["ts-flag-parser", "ts-order-validator"]), "--treatment", "control");

  const parsed = parseCliArgs(argv);

  assertParsedCollect(parsed, { repetitions: 3, timeoutMs: 60000, cases: ["ts-flag-parser", "ts-order-validator"], treatments: ["control"] });
});

test("parseCliArgs_reports_error_when_collect_is_missing_model", () => {
  const parsed = parseCliArgs(["collect", "--run", "baseline"]);

  assert.ok("error" in parsed);
});

test("parseCliArgs_reports_error_when_collect_is_missing_run", () => {
  const parsed = parseCliArgs(["collect", "--model", "anthropic/claude-test"]);

  assert.ok("error" in parsed);
});

test("parseCliArgs_defaults_repetitions_to_five_when_omitted", () => {
  const parsed = parseCliArgs(["collect", "--run", "baseline", "--model", "anthropic/claude-test"]);

  assertParsedCollect(parsed, {});
});

test("parseCliArgs_rejects_non_integer_repetitions", () => {
  const parsed = parseCliArgs(["collect", "--run", "baseline", "--model", "anthropic/claude-test", "--repetitions", "1.5"]);

  assert.ok("error" in parsed);
});

test("parseCliArgs_parses_the_parallel_flag_into_collect_opts", () => {
  const parsed = parseCliArgs(collectArgv("--parallel", "3"));

  assertParsedCollect(parsed, { parallel: 3 });
});

test("parseCliArgs_defaults_parallel_to_one_when_omitted", () => {
  const parsed = parseCliArgs(collectArgv("--repetitions", "2"));

  assertParsedCollect(parsed, { repetitions: 2 });
});

test("parseCliArgs_rejects_non_integer_parallel", () => {
  const parsed = parseCliArgs(collectArgv("--parallel", "1.5"));

  assert.ok("error" in parsed);
});

test("parseCliArgs_accumulates_repeated_case_flags", () => {
  const parsed = parseCliArgs(collectArgv(...repeated("--case", ["a", "b", "c"])));

  assertParsedCollect(parsed, { cases: ["a", "b", "c"] });
});

test("parseCliArgs_parses_the_tier_flag_into_collect_opts", () => {
  const parsed = parseCliArgs(collectArgv("--tier", "easy"));

  assertParsedCollect(parsed, { tier: "easy" });
});

test("parseCliArgs_rejects_an_unknown_tier_value", () => {
  const parsed = parseCliArgs(collectArgv("--tier", "medium"));

  assert.ok("error" in parsed);
});

test("parseCliArgs_parses_the_reasoning_flag_into_collect_opts", () => {
  const parsed = parseCliArgs(collectArgv("--reasoning", "xhigh"));

  assertParsedCollect(parsed, { reasoning: "xhigh" });
});

test("parseCliArgs_rejects_a_reasoning_level_pi_does_not_accept", () => {
  const parsed = parseCliArgs(collectArgv("--reasoning", "extreme"));

  assert.ok("error" in parsed);
});

test("parseCliArgs_parses_score_with_compare", () => {
  const parsed = parseCliArgs(["score", "--run", "baseline", "--compare", "rails-default"]);

  assert.deepEqual(parsed, { cmd: "score", run: "baseline", compare: "rails-default" });
});

test("parseCliArgs_reports_error_when_score_is_missing_run", () => {
  const parsed = parseCliArgs(["score", "--compare", "rails-default"]);

  assert.ok("error" in parsed);
});

test("parseCliArgs_reports_usage_error_for_unknown_subcommand", () => {
  const parsed = parseCliArgs(["bogus"]);

  assert.ok("error" in parsed);
});

test("parseCliArgs_reports_error_for_unknown_flag", () => {
  const parsed = parseCliArgs(["collect", "--run", "baseline", "--model", "anthropic/claude-test", "--bogus", "x"]);

  assert.ok("error" in parsed);
});

test("runEval_routes_collect_to_the_collect_dependency_with_resolved_run_dir", async () => {
  const { collect, calls } = recordingCollect({ status: 0, rowsWritten: 3, rowsSkipped: 1, stderr: "" });

  const result = await runEval(["collect", "--run", "baseline", "--model", "anthropic/claude-test"], { collect });

  assert.equal(calls[0]?.runDir, join(REPO_ROOT, "engine", "eval", "runs", "baseline"));
  assert.equal(calls[0]?.repoRoot, REPO_ROOT);
  assert.equal(result.stdout, "rows written: 3, skipped: 1");
});

test("runEval_routes_score_to_the_score_dependency_with_corpus_dir", async () => {
  const { score, calls } = recordingScore({ status: 0, stdout: "table" });

  const result = await runEval(["score", "--run", "baseline"], { score });

  assert.equal(calls[0]?.corpusDir, join(REPO_ROOT, "engine", "eval", "corpus"));
  assert.equal(calls[0]?.runDir, join(REPO_ROOT, "engine", "eval", "runs", "baseline"));
  assert.equal(calls[0]?.repoRoot, REPO_ROOT);
  assert.equal(result.stdout, "table");
});

test("runEval_passes_parallel_through_to_the_collect_dependency", async () => {
  const { collect, calls } = recordingCollect({ status: 0, rowsWritten: 1, rowsSkipped: 0, stderr: "" });

  await runEval(["collect", "--run", "baseline", "--model", "anthropic/claude-test", "--parallel", "3"], { collect });

  assert.equal(calls[0]?.parallel, 3);
});

test("runEval_passes_tier_through_to_the_collect_dependency", async () => {
  const { collect, calls } = recordingCollect({ status: 0, rowsWritten: 1, rowsSkipped: 0, stderr: "" });

  await runEval(["collect", "--run", "baseline", "--model", "anthropic/claude-test", "--tier", "hard"], { collect });

  assert.equal(calls[0]?.tier, "hard");
});

test("runEval_passes_reasoning_through_to_the_collect_dependency", async () => {
  const { collect, calls } = recordingCollect({ status: 0, rowsWritten: 1, rowsSkipped: 0, stderr: "" });

  await runEval(["collect", "--run", "baseline", "--model", "anthropic/claude-test", "--reasoning", "low"], { collect });

  assert.equal(calls[0]?.reasoning, "low");
});

test("runEval_leaves_reasoning_unset_for_the_collect_dependency_to_default_when_the_flag_is_omitted", async () => {
  const { collect, calls } = recordingCollect({ status: 0, rowsWritten: 1, rowsSkipped: 0, stderr: "" });

  await runEval(["collect", "--run", "baseline", "--model", "anthropic/claude-test"], { collect });

  assert.equal(calls[0]?.reasoning, undefined);
});

test("runEval_propagates_nonzero_status_from_dependency", async () => {
  const { collect } = recordingCollect({ status: 1, rowsWritten: 0, rowsSkipped: 0, stderr: "boom" });

  const result = await runEval(["collect", "--run", "baseline", "--model", "anthropic/claude-test"], { collect });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "boom");
});

test("runEval_reports_usage_error_in_stderr_with_status_one_for_bad_args", async () => {
  const result = await runEval([]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage/i);
});

test("runEval_wraps_a_thrown_dependency_error_into_a_clean_status_one_failure", async () => {
  const collect = throwingCollect("ENOENT: no such file or directory, open 'raw.jsonl'");

  const result = await runEval(["collect", "--run", "baseline", "--model", "anthropic/claude-test"], { collect });

  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes("at "), false);
  assert.match(result.stderr, /ENOENT/);
});

function followUpArgv(...extra: string[]): string[] {
  return ["follow-up", "--run", "extended", "--source-run", "baseline", "--model", "anthropic/claude-test", ...extra];
}

function assertParsedFollowUp(parsed: ParsedCli, over: Partial<Extract<ParsedCli, { cmd: "follow-up" }>>): void {
  assert.deepEqual(parsed, {
    cmd: "follow-up",
    run: "extended",
    sourceRun: "baseline",
    model: "anthropic/claude-test",
    parallel: 1,
    ...over,
  });
}

function recordingFollowUp(result: FollowUpResult): { followUp: (opts: FollowUpOpts) => Promise<FollowUpResult>; calls: FollowUpOpts[] } {
  const calls: FollowUpOpts[] = [];
  const followUp = async (opts: FollowUpOpts): Promise<FollowUpResult> => {
    calls.push(opts);
    return result;
  };
  return { followUp, calls };
}

test("parseCliArgs_parses_a_full_follow_up_invocation", () => {
  const argv = followUpArgv(
    "--parallel",
    "3",
    "--timeout-ms",
    "60000",
    ...repeated("--case", ["ts-flag-parser", "ts-order-fulfillment"]),
    "--treatment",
    "rails-default",
  );

  const parsed = parseCliArgs(argv);

  assertParsedFollowUp(parsed, {
    parallel: 3,
    timeoutMs: 60000,
    cases: ["ts-flag-parser", "ts-order-fulfillment"],
    treatments: ["rails-default"],
  });
});

test("parseCliArgs_defaults_follow_up_parallel_to_one_when_omitted", () => {
  const parsed = parseCliArgs(followUpArgv());

  assertParsedFollowUp(parsed, {});
});

test("parseCliArgs_parses_the_reasoning_flag_into_follow_up_opts", () => {
  const parsed = parseCliArgs(followUpArgv("--reasoning", "xhigh"));

  assertParsedFollowUp(parsed, { reasoning: "xhigh" });
});

test("parseCliArgs_rejects_a_reasoning_level_pi_does_not_accept_for_follow_up", () => {
  const parsed = parseCliArgs(followUpArgv("--reasoning", "extreme"));

  assert.ok("error" in parsed);
});

test("parseCliArgs_reports_error_when_follow_up_is_missing_run", () => {
  const parsed = parseCliArgs(["follow-up", "--source-run", "baseline", "--model", "anthropic/claude-test"]);

  assert.ok("error" in parsed);
});

test("parseCliArgs_reports_error_when_follow_up_is_missing_source_run", () => {
  const parsed = parseCliArgs(["follow-up", "--run", "extended", "--model", "anthropic/claude-test"]);

  assert.ok("error" in parsed);
});

test("parseCliArgs_reports_error_when_follow_up_is_missing_model", () => {
  const parsed = parseCliArgs(["follow-up", "--run", "extended", "--source-run", "baseline"]);

  assert.ok("error" in parsed);
});

function assertFollowUpRunAndSourceRunResolved(calls: FollowUpOpts[]): void {
  assert.equal(calls[0]?.runDir, join(REPO_ROOT, "engine", "eval", "runs", "extended"));
  assert.equal(calls[0]?.sourceRunDir, join(REPO_ROOT, "engine", "eval", "runs", "baseline"));
  assert.equal(calls[0]?.sourceRun, "baseline");
}

test("runEval_routes_follow_up_to_the_dependency_with_resolved_run_and_source_run_dirs", async () => {
  const { followUp, calls } = recordingFollowUp({ status: 0, rowsWritten: 2, rowsSkipped: 0, stderr: "" });

  const result = await runEval(["follow-up", "--run", "extended", "--source-run", "baseline", "--model", "anthropic/claude-test"], { followUp });

  assertFollowUpRunAndSourceRunResolved(calls);
  assert.equal(result.stdout, "rows written: 2, skipped: 0");
});

test("runEval_passes_reasoning_through_to_the_follow_up_dependency", async () => {
  const { followUp, calls } = recordingFollowUp({ status: 0, rowsWritten: 1, rowsSkipped: 0, stderr: "" });

  await runEval(["follow-up", "--run", "extended", "--source-run", "baseline", "--model", "anthropic/claude-test", "--reasoning", "low"], { followUp });

  assert.equal(calls[0]?.reasoning, "low");
});

test("runEval_leaves_reasoning_unset_for_the_follow_up_dependency_to_default_when_the_flag_is_omitted", async () => {
  const { followUp, calls } = recordingFollowUp({ status: 0, rowsWritten: 1, rowsSkipped: 0, stderr: "" });

  await runEval(["follow-up", "--run", "extended", "--source-run", "baseline", "--model", "anthropic/claude-test"], { followUp });

  assert.equal(calls[0]?.reasoning, undefined);
});

test("runEval_propagates_follow_up_stderr_and_nonzero_status", async () => {
  const { followUp } = recordingFollowUp({ status: 1, rowsWritten: 0, rowsSkipped: 0, stderr: "boom" });

  const result = await runEval(["follow-up", "--run", "extended", "--source-run", "baseline", "--model", "anthropic/claude-test"], { followUp });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "boom");
});
