import {
  MAX_CONCURRENCY,
  childDepthOf,
  currentDepth,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  loadComplexityMap,
  mapWithConcurrencyLimit,
  selectMode,
  taskPreview,
  type Complexity,
  type ComplexityMap,
  type SingleResult,
  type SpawnMode,
  type SubagentDetails,
  type UsageStats,
} from "./child.ts";
import { ChildSession, type ChildTransport, type DialogGate, type DialogOptions, type UiForwarder } from "./bridge.ts";
import {
  gateChildReport,
  getSuspended,
  initSuspend,
  singleSpawnResult,
  spawnBlockedResult,
  type ChildUpdate,
  type RunChildOutcome,
  type SuspendedState,
  type ToolResult,
} from "./clarify.ts";

export interface SpawnContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    confirm(title: string, message: string, opts?: DialogOptions): Promise<boolean>;
    select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
    input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export type TransportFactory = (
  cwd: string,
  model: string,
  depthEnv: string,
  onStderr: (data: string) => void,
) => ChildTransport;

export interface SpawnDeps {
  spawnTransport: TransportFactory;
  loadComplexity?: () => ComplexityMap;
}

export interface SpawnParams {
  task?: string;
  complexity?: Complexity;
  tasks?: { task: string; complexity: Complexity }[];
}

export type SpawnUpdate = (update: ToolResult) => void;

const emptyUsage = (): UsageStats => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
});

const detailsOf = (mode: SpawnMode, results: SingleResult[]): SubagentDetails => ({ mode, results });

const textResult = (mode: SpawnMode, text: string, isError?: boolean): ToolResult => ({
  content: [{ type: "text", text }],
  details: detailsOf(mode, []),
  ...(isError ? { isError } : {}),
});

async function runChild(
  deps: SpawnDeps,
  ctx: SpawnContext,
  task: string,
  model: string,
  signal: AbortSignal | undefined,
  onUpdate: ChildUpdate | undefined,
  gate: DialogGate,
  mode: SpawnMode,
): Promise<RunChildOutcome> {
  const depthEnv = String(childDepthOf(currentDepth()));
  const result: SingleResult = {
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model,
  };
  const budget = { delivered: 0 };

  const emitUpdate = () => onUpdate?.(result);

  const forwarder: UiForwarder = {
    hasUI: ctx.hasUI,
    confirm: (t, m, o) => ctx.ui.confirm(t, m, o),
    select: (t, o, s) => ctx.ui.select(t, o, s),
    input: (t, p, o) => ctx.ui.input(t, p, o),
    editor: (t, p) => ctx.ui.editor(t, p),
    notify: (m, ty) => ctx.ui.notify(m, ty),
  };

  const transport = deps.spawnTransport(ctx.cwd, model, depthEnv, (s) => {
    result.stderr += s;
  });
  const session = new ChildSession(transport, forwarder, result, emitUpdate, signal, gate, mode, budget);

  const t = await session.sendPrompt(`Task: ${task}`);
  if (t.suspended && t.clarify) {
    const state: SuspendedState = {
      clarifyId: t.clarify.id,
      question: t.clarify.question,
      transport,
      session,
      result,
      budget,
      onUpdate,
      mode,
      timer: null,
      finished: false,
    };
    initSuspend(state, signal);
    return { kind: "suspended", clarify: t.clarify, result };
  }

  result.exitCode = t.exitCode;
  result.settled = t.settled;
  if (t.aborted) throw new Error("Spawned child was aborted");
  if (!t.settled) result.errorMessage ??= `child exited (code ${t.exitCode}) before completing its turn`;
  try {
    if (!isFailedResult(result)) await gateChildReport(result, session, onUpdate);
  } finally {
    session.close();
  }
  return { kind: "done", result };
}

async function runSingle(
  deps: SpawnDeps,
  ctx: SpawnContext,
  task: string,
  model: string,
  signal: AbortSignal | undefined,
  onUpdate: SpawnUpdate | undefined,
  gate: DialogGate,
): Promise<ToolResult> {
  if (getSuspended()) return spawnBlockedResult();

  const childUpdate: ChildUpdate | undefined = onUpdate
    ? (r) =>
        onUpdate({
          content: [{ type: "text", text: getFinalOutput(r.messages) || "(running...)" }],
          details: detailsOf("single", [r]),
        })
    : undefined;

  return singleSpawnResult(await runChild(deps, ctx, task, model, signal, childUpdate, gate, "single"));
}

// Every task is seeded as running (exitCode -1) so the progress line can count
// them before any child has reported.
async function runParallel(
  deps: SpawnDeps,
  ctx: SpawnContext,
  tasks: { task: string; complexity: Complexity }[],
  complexityMap: ComplexityMap,
  signal: AbortSignal | undefined,
  onUpdate: SpawnUpdate | undefined,
  gate: DialogGate,
): Promise<ToolResult> {
  const allResults: SingleResult[] = tasks.map((t) => ({
    task: t.task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: complexityMap[t.complexity],
  }));

  const emitProgress = () => {
    if (!onUpdate) return;
    const running = allResults.filter((r) => r.exitCode === -1).length;
    const done = allResults.length - running;
    onUpdate({
      content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
      details: detailsOf("parallel", [...allResults]),
    });
  };

  const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
    const outcome = await runChild(
      deps,
      ctx,
      t.task,
      complexityMap[t.complexity],
      signal,
      (r) => {
        allResults[index] = r;
        emitProgress();
      },
      gate,
      "parallel",
    );
    allResults[index] = outcome.result;
    emitProgress();
    return outcome.result;
  });

  const successCount = results.filter((r) => !isFailedResult(r)).length;
  const summaries = results.map((r) => {
    const output = r.finalReport ?? getResultOutput(r);
    const status = isFailedResult(r)
      ? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
      : "completed";
    return `### [${taskPreview(r.task)}] ${status}\n\n${output}`;
  });

  return {
    content: [
      { type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` },
    ],
    details: detailsOf("parallel", results),
  };
}

export async function runSpawn(
  deps: SpawnDeps,
  ctx: SpawnContext,
  params: SpawnParams,
  signal: AbortSignal | undefined,
  onUpdate: SpawnUpdate | undefined,
  gate: DialogGate,
): Promise<ToolResult> {
  const selection = selectMode(params);
  if (selection.kind === "error") return textResult("single", selection.message);

  let complexityMap: ComplexityMap;
  try {
    complexityMap = (deps.loadComplexity ?? loadComplexityMap)();
  } catch (e) {
    return textResult(selection.kind, e instanceof Error ? e.message : String(e), true);
  }

  return selection.kind === "parallel"
    ? runParallel(deps, ctx, params.tasks!, complexityMap, signal, onUpdate, gate)
    : runSingle(deps, ctx, params.task!, complexityMap[params.complexity!], signal, onUpdate, gate);
}
