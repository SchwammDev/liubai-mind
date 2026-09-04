import { join } from "node:path";

import { runCollect } from "./collect.ts";
import { runScore } from "./score.ts";
import { runSecondTouch } from "./second-touch.ts";
import { routeScore } from "./second-touch-score.ts";
import type { Tier } from "./eval-contract.ts";

export type ParsedCli =
  | {
      cmd: "collect";
      run: string;
      model: string;
      reps: number;
      parallel: number;
      timeoutMs?: number;
      cases?: string[];
      treatments?: string[];
      tier?: Tier;
    }
  | {
      cmd: "second-touch";
      run: string;
      sourceRun: string;
      model: string;
      parallel: number;
      timeoutMs?: number;
      cases?: string[];
      treatments?: string[];
    }
  | { cmd: "score"; run: string; compare?: string }
  | { error: string };

interface EvalRunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_REPS = 5;
const DEFAULT_PARALLEL = 1;

const USAGE = [
  "Usage:",
  "  liubai eval collect --run <name> --model <provider/id> [--reps N] [--parallel N] [--timeout-ms N] [--case id]... [--treatment id]... [--tier <easy|hard>]",
  "  liubai eval second-touch --run <newRun> --source-run <existingRun> --model <provider/id> [--parallel N] [--timeout-ms N] [--case id]... [--treatment id]...",
  "  liubai eval score --run <name> [--compare <otherRunName>]",
].join("\n");

function usageError(detail: string): { error: string } {
  return { error: `${USAGE}\n${detail}` };
}

interface CollectAccum {
  run?: string;
  model?: string;
  repsRaw?: string;
  parallelRaw?: string;
  timeoutMsRaw?: string;
  tierRaw?: string;
  cases: string[];
  treatments: string[];
}

interface SecondTouchAccum {
  run?: string;
  sourceRun?: string;
  model?: string;
  parallelRaw?: string;
  timeoutMsRaw?: string;
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
    "--reps": (a, v) => { a.repsRaw = v; },
    "--parallel": (a, v) => { a.parallelRaw = v; },
    "--timeout-ms": (a, v) => { a.timeoutMsRaw = v; },
    "--case": (a, v) => { a.cases.push(v); },
    "--treatment": (a, v) => { a.treatments.push(v); },
    "--tier": (a, v) => { a.tierRaw = v; },
  };
}

function secondTouchFlagHandlers(): FlagHandlers<SecondTouchAccum> {
  return {
    "--run": (a, v) => { a.run = v; },
    "--source-run": (a, v) => { a.sourceRun = v; },
    "--model": (a, v) => { a.model = v; },
    "--parallel": (a, v) => { a.parallelRaw = v; },
    "--timeout-ms": (a, v) => { a.timeoutMsRaw = v; },
    "--case": (a, v) => { a.cases.push(v); },
    "--treatment": (a, v) => { a.treatments.push(v); },
  };
}

function scoreFlagHandlers(): FlagHandlers<ScoreAccum> {
  return {
    "--run": (a, v) => { a.run = v; },
    "--compare": (a, v) => { a.compare = v; },
  };
}

function parseReps(raw: string | undefined): { value: number } | { error: string } {
  if (raw === undefined) return { value: DEFAULT_REPS };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { error: `--reps must be a positive integer, got: ${raw}` };
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

function collectOptionalFields(accum: CollectAccum, tier: Tier | undefined): Partial<Extract<ParsedCli, { cmd: "collect" }>> {
  const timeoutMs = accum.timeoutMsRaw === undefined ? undefined : Number(accum.timeoutMsRaw);

  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(accum.cases.length > 0 ? { cases: accum.cases } : {}),
    ...(accum.treatments.length > 0 ? { treatments: accum.treatments } : {}),
    ...(tier !== undefined ? { tier } : {}),
  };
}

function buildCollectResult(accum: CollectAccum): ParsedCli {
  if (accum.run === undefined) return usageError("collect requires --run");
  if (accum.model === undefined) return usageError("collect requires --model");

  const reps = parseReps(accum.repsRaw);
  if ("error" in reps) return usageError(reps.error);

  const parallel = parseParallel(accum.parallelRaw);
  if ("error" in parallel) return usageError(parallel.error);

  const tier = parseTier(accum.tierRaw);
  if ("error" in tier) return usageError(tier.error);

  return {
    cmd: "collect",
    run: accum.run,
    model: accum.model,
    reps: reps.value,
    parallel: parallel.value,
    ...collectOptionalFields(accum, tier.value),
  };
}

function parseCollectArgs(args: string[]): ParsedCli {
  const accum: CollectAccum = { cases: [], treatments: [] };
  const flagError = consumeFlags(args, collectFlagHandlers(), accum);
  if (flagError !== undefined) return usageError(flagError.error);
  return buildCollectResult(accum);
}

function secondTouchOptionalFields(accum: SecondTouchAccum): Partial<Extract<ParsedCli, { cmd: "second-touch" }>> {
  const timeoutMs = accum.timeoutMsRaw === undefined ? undefined : Number(accum.timeoutMsRaw);

  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(accum.cases.length > 0 ? { cases: accum.cases } : {}),
    ...(accum.treatments.length > 0 ? { treatments: accum.treatments } : {}),
  };
}

function buildSecondTouchResult(accum: SecondTouchAccum): ParsedCli {
  if (accum.run === undefined) return usageError("second-touch requires --run");
  if (accum.sourceRun === undefined) return usageError("second-touch requires --source-run");
  if (accum.model === undefined) return usageError("second-touch requires --model");

  const parallel = parseParallel(accum.parallelRaw);
  if ("error" in parallel) return usageError(parallel.error);

  return {
    cmd: "second-touch",
    run: accum.run,
    sourceRun: accum.sourceRun,
    model: accum.model,
    parallel: parallel.value,
    ...secondTouchOptionalFields(accum),
  };
}

function parseSecondTouchArgs(args: string[]): ParsedCli {
  const accum: SecondTouchAccum = { cases: [], treatments: [] };
  const flagError = consumeFlags(args, secondTouchFlagHandlers(), accum);
  if (flagError !== undefined) return usageError(flagError.error);
  return buildSecondTouchResult(accum);
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
  if (sub === "second-touch") return parseSecondTouchArgs(rest);
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
    reps: parsed.reps,
    parallel: parsed.parallel,
    model: parsed.model,
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.cases !== undefined ? { cases: parsed.cases } : {}),
    ...(parsed.treatments !== undefined ? { treatments: parsed.treatments } : {}),
    ...(parsed.tier !== undefined ? { tier: parsed.tier } : {}),
  });

  return {
    status: result.status,
    stdout: `rows written: ${result.rowsWritten}, skipped: ${result.rowsSkipped}`,
    stderr: result.stderr,
  };
}

async function runSecondTouchCmd(
  parsed: Extract<ParsedCli, { cmd: "second-touch" }>,
  secondTouch: typeof runSecondTouch,
  repoRoot: string,
  runsRoot: string,
): Promise<EvalRunResult> {
  const result = await secondTouch({
    repoRoot,
    runDir: join(runsRoot, parsed.run),
    sourceRunDir: join(runsRoot, parsed.sourceRun),
    sourceRun: parsed.sourceRun,
    parallel: parsed.parallel,
    model: parsed.model,
    ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
    ...(parsed.cases !== undefined ? { cases: parsed.cases } : {}),
    ...(parsed.treatments !== undefined ? { treatments: parsed.treatments } : {}),
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
  deps?: { collect?: typeof runCollect; secondTouch?: typeof runSecondTouch; score?: typeof runScore },
): Promise<EvalRunResult> {
  const parsed = parseCliArgs(argv);
  if ("error" in parsed) return { status: 1, stdout: "", stderr: `${parsed.error}\n` };

  const repoRoot = join(import.meta.dirname, "..", "..");
  const runsRoot = join(repoRoot, "engine", "eval", "runs");

  try {
    if (parsed.cmd === "collect") return await runCollectCmd(parsed, deps?.collect ?? runCollect, repoRoot, runsRoot);
    if (parsed.cmd === "second-touch") return await runSecondTouchCmd(parsed, deps?.secondTouch ?? runSecondTouch, repoRoot, runsRoot);
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
