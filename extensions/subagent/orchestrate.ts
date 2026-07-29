import {
  MAX_CONCURRENCY,
  childDepthOf,
  currentDepth,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  loadComplexitySelection,
  mapWithConcurrencyLimit,
  selectMode,
  taskPreview,
  type Complexity,
  type ComplexitySelection,
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
import {
  assignTasks,
  chooseTier,
  type ModelCatalog,
  type TaskAssignment,
  type TierChoice,
} from "./tier-model.ts";
import { LIUBAI_CONFIG, loadWebSearchConfig, type WebSearchConfig } from "../rails/web-search.ts";

export interface SpawnContext {
  cwd: string;
  hasUI: boolean;
  modelRegistry: ModelCatalog;
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
  loadComplexity?: () => ComplexitySelection;
  loadWebSearch?: () => WebSearchConfig;
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
  choice: TierChoice,
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
    model: choice.reference,
    notes: choice.notes,
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

  const transport = deps.spawnTransport(ctx.cwd, choice.reference, depthEnv, (s) => {
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
  profile: string,
  task: string,
  choice: TierChoice,
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

  const outcome = await runChild(deps, ctx, task, choice, signal, childUpdate, gate, "single");
  outcome.result.profile = profile;
  return singleSpawnResult(outcome);
}

// Every task is seeded as running (exitCode -1) so the progress line can count
// them before any child has reported.
async function runParallel(
  deps: SpawnDeps,
  ctx: SpawnContext,
  profile: string,
  assignments: TaskAssignment[],
  signal: AbortSignal | undefined,
  onUpdate: SpawnUpdate | undefined,
  gate: DialogGate,
): Promise<ToolResult> {
  const allResults: SingleResult[] = assignments.map((a) => ({
    task: a.task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: a.choice.reference,
    notes: a.choice.notes,
    profile,
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

  const results = await mapWithConcurrencyLimit(assignments, MAX_CONCURRENCY, async (a, index) => {
    const outcome = await runChild(
      deps,
      ctx,
      a.task,
      a.choice,
      signal,
      (r) => {
        allResults[index] = r;
        emitProgress();
      },
      gate,
      "parallel",
    );
    allResults[index] = outcome.result;
    outcome.result.profile = profile;
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
  const mode = selectMode(params);
  if (mode.kind === "error") return textResult("single", mode.message);

  let complexity: ComplexitySelection;
  try {
    complexity = (deps.loadComplexity ?? loadComplexitySelection)();
  } catch (e) {
    return textResult(mode.kind, e instanceof Error ? e.message : String(e), true);
  }
  const complexityMap = complexity.map;

  const catalog = ctx.modelRegistry;
  const searchProviders = (deps.loadWebSearch ?? (() => loadWebSearchConfig(LIUBAI_CONFIG)))().providers;

  if (mode.kind === "parallel") {
    const assigned = assignTasks(params.tasks!, complexityMap, catalog, searchProviders);
    return assigned.kind === "error"
      ? textResult("parallel", assigned.message, true)
      : runParallel(deps, ctx, complexity.profile, assigned.value, signal, onUpdate, gate);
  }

  const chosen = chooseTier(params.complexity!, complexityMap, catalog, searchProviders);
  return chosen.kind === "error"
    ? textResult("single", chosen.message, true)
    : runSingle(deps, ctx, complexity.profile, params.task!, chosen.value, signal, onUpdate, gate);
}
