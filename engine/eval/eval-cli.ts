import { join } from "node:path";

import { runCollect } from "./collect.ts";
import { runScore } from "./score.ts";
import { runFollowUp } from "./follow-up.ts";
import { routeScore } from "./follow-up-score.ts";
import type { Tier } from "./eval-contract.ts";
import { REASONING_LEVELS } from "./spawner.ts";

export type ParsedCli =
  | {
      cmd: "collect";
      run: string;
      model: string;
      repetitions: number;
      parallel: number;
      timeoutMs?: number;
      cases?: string[];
      treatments?: string[];
      tier?: Tier;
      reasoning?: string;
    }
  | {
      cmd: "follow-up";
      run: string;
      sourceRun: string;
      model: string;
      parallel: number;
      timeoutMs?: number;
      cases?: string[];
      treatments?: string[];
      reasoning?: string;
    }
  | { cmd: "score"; run: string; compare?: string }
  | { error: string };

interface EvalRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_REPETITIONS = 5;
const DEFAULT_PARALLEL = 1;

const USAGE = [
  "Usage:",
  "  liubai eval collect --run <name> --model <provider/id> [--repetitions N] [--parallel N] [--timeout-ms N] [--case id]... [--treatment id]... [--tier <easy|hard>] [--reasoning <off|minimal|low|medium|high|xhigh|max>]",
  "  liubai eval follow-up --run <newRun> --source-run <existingRun> --model <provider/id> [--parallel N] [--timeout-ms N] [--case id]... [--treatment id]... [--reasoning <off|minimal|low|medium|high|xhigh|max>]",
  "  liubai eval score --run <name> [--compare <otherRunName>]",
].join("\n");

function usageError(detail: string): { error: string } {
  return { error: `${USAGE}\n${detail}` };
}

interface CollectAccum {
  run?: string;
  model?: string;
  repetitionsRaw?: string;
  parallelRaw?: string;
  timeoutMsRaw?: string;
  tierRaw?: string;
  reasoningRaw?: string;
  cases: string[];
  treatments: string[];
}

interface FollowUpAccum {
  run?: string;
  sourceRun?: string;
  model?: string;
  parallelRaw?: string;
  timeoutMsRaw?: string;
  reasoningRaw?: string;
  cases: string[];
  treatments: string[];
}

interface ScoreAccum {
  run?: string;
  compare?: string;
}

type FlagHandlers<T> = Record<string, (accum: T, value: string) => void>;

function consumeFlags<T>(args: string[], handlers: FlagHandlers<T>, accum: T): { error: string } | undefined {
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    const handler = flag === undefined ? undefined : handlers[flag];
    if (handler === undefined) return { error: `unknown flag: ${flag ?? ""}` };
    if (value === undefined) return { error: `missing value for ${flag}` };
    handler(accum, value);
  }
  return undefined;
}

function collectFlagHandlers(): FlagHandlers<CollectAccum> {
  return {
    "--run": (a, v) => { a.run = v; },
    "--model": (a, v) => { a.model = v; },
    "--repetitions": (a, v) => { a.repetitionsRaw = v; },
    "--parallel": (a, v) => { a.parallelRaw = v; },
    "--timeout-ms": (a, v) => { a.timeoutMsRaw = v; },
    "--case": (a, v) => { a.cases.push(v); },
    "--treatment": (a, v) => { a.treatments.push(v); },
    "--tier": (a, v) => { a.tierRaw = v; },
    "--reasoning": (a, v) => { a.reasoningRaw = v; },
  };
}

function followUpFlagHandlers(): FlagHandlers<FollowUpAccum> {
  return {
    "--run": (a, v) => { a.run = v; },
    "--source-run": (a, v) => { a.sourceRun = v; },
    "--model": (a, v) => { a.model = v; },
    "--parallel": (a, v) => { a.parallelRaw = v; },
    "--timeout-ms": (a, v) => { a.timeoutMsRaw = v; },
    "--case": (a, v) => { a.cases.push(v); },
    "--treatment": (a, v) => { a.treatments.push(v); },
    "--reasoning": (a, v) => { a.reasoningRaw = v; },
  };
}

function scoreFlagHandlers(): FlagHandlers<ScoreAccum> {
  return {
    "--run": (a, v) => { a.run = v; },
    "--compare": (a, v) => { a.compare = v; },
  };
}

function parseRepetitions(raw: string | undefined): { value: number } | { error: string } {
  if (raw === undefined) return { value: DEFAULT_REPETITIONS };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { error: `--repetitions must be a positive integer, got: ${raw}` };
  return { value: n };
}

function parseParallel(raw: string | undefined): { value: number } | { error: string } {
  if (raw === undefined) return { value: DEFAULT_PARALLEL };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { error: `--parallel must be a positive integer, got: ${raw}` };
  return { value: n };
}

function parseTier(raw: string | undefined): { value: Tier | undefined } | { error: string } {
  if (raw === undefined) return { value: undefined };
  if (raw === "easy" || raw === "hard") return { value: raw };
  return { error: `--tier must be "easy" or "hard", got: ${raw}` };
}

function parseReasoning(raw: string | undefined): { value: string | undefined } | { error: string } {
  if (raw === undefined) return { value: undefined };
  if ((REASONING_LEVELS as readonly string[]).includes(raw)) return { value: raw };
  return { error: `--reasoning must be one of ${REASONING_LEVELS.join(", ")}, got: ${raw}` };
}

function collectOptionalFields(
  accum: CollectAccum,
  tier: Tier | undefined,
  reasoning: string | undefined,
): Partial<Extract<ParsedCli, { cmd: "collect" }>> {
  const timeoutMs = accum.timeoutMsRaw === undefined ? undefined : Number(accum.timeoutMsRaw);

  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(accum.cases.length > 0 ? { cases: accum.cases } : {}),
    ...(accum.treatments.length > 0 ? { treatments: accum.treatments } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

function buildCollectResult(accum: CollectAccum): ParsedCli {
  if (accum.run === undefined) return usageError("collect requires --run");
  if (accum.model === undefined) return usageError("collect requires --model");

  const repetitions = parseRepetitions(accum.repetitionsRaw);
  if ("error" in repetitions) return usageError(repetitions.error);

  const parallel = parseParallel(accum.parallelRaw);
  if ("error" in parallel) return usageError(parallel.error);

  const tier = parseTier(accum.tierRaw);
  if ("error" in tier) return usageError(tier.error);

  const reasoning = parseReasoning(accum.reasoningRaw);
  if ("error" in reasoning) return usageError(reasoning.error);

  return {
    cmd: "collect",
    run: accum.run,
    model: accum.model,
    repetitions: repetitions.value,
    parallel: parallel.value,
    ...collectOptionalFields(accum, tier.value, reasoning.value),
  };
}

function parseCollectArgs(args: string[]): ParsedCli {
  const accum: CollectAccum = { cases: [], treatments: [] };
  const flagError = consumeFlags(args, collectFlagHandlers(), accum);
  if (flagError !== undefined) return usageError(flagError.error);
  return buildCollectResult(accum);
}

function followUpOptionalFields(accum: FollowUpAccum, reasoning: string | undefined): Partial<Extract<ParsedCli, { cmd: "follow-up" }>> {
  const timeoutMs = accum.timeoutMsRaw === undefined ? undefined : Number(accum.timeoutMsRaw);

  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(accum.cases.length > 0 ? { cases: accum.cases } : {}),
    ...(accum.treatments.length > 0 ? { treatments: accum.treatments } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}

function buildFollowUpResult(accum: FollowUpAccum): ParsedCli {
  if (accum.run === undefined) return usageError("follow-up requires --run");
  if (accum.sourceRun === undefined) return usageError("follow-up requires --source-run");
  if (accum.model === undefined) return usageError("follow-up requires --model");

  const parallel = parseParallel(accum.parallelRaw);
  if ("error" in parallel) return usageError(parallel.error);

  const reasoning = parseReasoning(accum.reasoningRaw);
  if ("error" in reasoning) return usageError(reasoning.error);

  return {
    cmd: "follow-up",
    run: accum.run,
    sourceRun: accum.sourceRun,
    model: accum.model,
    parallel: parallel.value,
    ...followUpOptionalFields(accum, reasoning.value),
  };
}

function parseFollowUpArgs(args: string[]): ParsedCli {
  const accum: FollowUpAccum = { cases: [], treatments: [] };
  const flagError = consumeFlags(args, followUpFlagHandlers(), accum);
  if (flagError !== undefined) return usageError(flagError.error);
  return buildFollowUpResult(accum);
}

function parseScoreArgs(args: string[]): ParsedCli {
  const accum: ScoreAccum = {};
  const flagError = consumeFlags(args, scoreFlagHandlers(), accum);
  if (flagError !== undefined) return usageError(flagError.error);
  if (accum.run === undefined) return usageError("score requires --run");

  return { cmd: "score", run: accum.run, ...(accum.compare !== undefined ? { compare: accum.compare } : {}) };
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const [sub, ...rest] = argv;
  if (sub === "collect") return parseCollectArgs(rest);
  if (sub === "follow-up") return parseFollowUpArgs(rest);
  if (sub === "score") return parseScoreArgs(rest);
  return usageError(`unknown subcommand: ${sub ?? ""}`);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runCollectCmd(
  parsed: Extract<ParsedCli, { cmd: "collect" }>,
  collect: typeof runCollect,
  repoRoot: string,
  runsRoot: string,
): Promise<EvalRunResult> {
  const result = await collect({
    repoRoot,
    runDir: join(runsRoot, parsed.run),
    repetitions: parsed.repetitions,
    parallel: parsed.parallel,
    model: parsed.model,
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.cases !== undefined ? { cases: parsed.cases } : {}),
    ...(parsed.treatments !== undefined ? { treatments: parsed.treatments } : {}),
    ...(parsed.tier !== undefined ? { tier: parsed.tier } : {}),
    ...(parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {}),
  });

  return {
    status: result.status,
    stdout: `rows written: ${result.rowsWritten}, skipped: ${result.rowsSkipped}`,
    stderr: result.stderr,
  };
}

async function runFollowUpCmd(
  parsed: Extract<ParsedCli, { cmd: "follow-up" }>,
  followUp: typeof runFollowUp,
  repoRoot: string,
  runsRoot: string,
): Promise<EvalRunResult> {
  const result = await followUp({
    repoRoot,
    runDir: join(runsRoot, parsed.run),
    sourceRunDir: join(runsRoot, parsed.sourceRun),
    sourceRun: parsed.sourceRun,
    parallel: parsed.parallel,
    model: parsed.model,
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.cases !== undefined ? { cases: parsed.cases } : {}),
    ...(parsed.treatments !== undefined ? { treatments: parsed.treatments } : {}),
    ...(parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {}),
  });

  return {
    status: result.status,
    stdout: `rows written: ${result.rowsWritten}, skipped: ${result.rowsSkipped}`,
    stderr: result.stderr,
  };
}

async function runScoreCmd(
  parsed: Extract<ParsedCli, { cmd: "score" }>,
  score: typeof runScore,
  repoRoot: string,
  runsRoot: string,
): Promise<EvalRunResult> {
  const result = await score({
    runDir: join(runsRoot, parsed.run),
    corpusDir: join(repoRoot, "engine", "eval", "corpus"),
    repoRoot,
    ...(parsed.compare !== undefined ? { compareRunDir: join(runsRoot, parsed.compare) } : {}),
  });

  return { status: result.status, stdout: result.stdout, stderr: "" };
}

function autoDetectScore(runsRoot: string): typeof runScore {
  return (opts) => routeScore(opts, runsRoot);
}

export async function runEval(
  argv: string[],
  deps?: { collect?: typeof runCollect; followUp?: typeof runFollowUp; score?: typeof runScore },
): Promise<EvalRunResult> {
  const parsed = parseCliArgs(argv);
  if ("error" in parsed) return { status: 1, stdout: "", stderr: `${parsed.error}\n` };

  const repoRoot = join(import.meta.dirname, "..", "..");
  const runsRoot = join(repoRoot, "engine", "eval", "runs");

  try {
    if (parsed.cmd === "collect") return await runCollectCmd(parsed, deps?.collect ?? runCollect, repoRoot, runsRoot);
    if (parsed.cmd === "follow-up") return await runFollowUpCmd(parsed, deps?.followUp ?? runFollowUp, repoRoot, runsRoot);
    return await runScoreCmd(parsed, deps?.score ?? autoDetectScore(runsRoot), repoRoot, runsRoot);
  } catch (err) {
    return { status: 1, stdout: "", stderr: `${formatError(err)}\n` };
  }
}

async function main(): Promise<void> {
  const res = await runEval(process.argv.slice(2));
  if (res.stdout) console.log(res.stdout);
  if (res.stderr) console.error(res.stderr);
  process.exit(res.status);
}

if (import.meta.main) {
  await main();
}
