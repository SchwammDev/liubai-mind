import { spawn } from "node:child_process";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  aggregateUsage,
  canSpawn,
  childDepthOf,
  COLLAPSED_ITEM_COUNT,
  currentDepth,
  type DisplayItem,
  formatToolCall,
  formatUsageStats,
  getDisplayItems,
  getFinalOutput,
  getPiInvocation,
  getResultOutput,
  isFailedResult,
  loadComplexityMap,
  MAX_CONCURRENCY,
  mapWithConcurrencyLimit,
  selectMode,
  type ComplexityMap,
  type SingleResult,
  taskPreview,
  compressPrompt,
  gateReport,
  hardTruncateReport,
  truncationNotice,
  type ReportAssessment,
} from "./child.ts";
import {
  type ChildTransport,
  type UiForwarder,
  ChildSession,
  DialogGate,
} from "./bridge.ts";

interface SubagentDetails {
  mode: "single" | "parallel";
  results: SingleResult[];
}

const makeDetails =
  (mode: "single" | "parallel") =>
  (results: SingleResult[]): SubagentDetails => ({ mode, results });

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });

type ChildUpdate = (result: SingleResult) => void;

function spawnRpcTransport(
  cwd: string,
  model: string,
  depthEnv: string,
  onStderr: (data: string) => void,
): ChildTransport {
  const args = ["--mode", "rpc", "--model", model];
  const invocation = getPiInvocation(args);
  const proc = spawn(invocation.command, invocation.args, {
    cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LIUBAI_SPAWN_DEPTH: depthEnv },
  });

  let stdoutBuffer = "";
  let closed = false;
  const lineCbs: ((line: string) => void)[] = [];
  const closeCbs: ((code: number | null) => void)[] = [];

  const fireClose = (code: number | null) => {
    if (closed) return;
    closed = true;
    if (stdoutBuffer.trim()) for (const cb of lineCbs) cb(stdoutBuffer);
    stdoutBuffer = "";
    for (const cb of closeCbs) cb(code);
  };

  proc.stdout.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) for (const cb of lineCbs) cb(line);
  });

  proc.stderr.on("data", (data: Buffer) => {
    onStderr(data.toString());
  });

  // A dead child's stdin rejects writes with EPIPE (a late extension_ui_response
  // after the child exited); swallow it so the parent doesn't crash. proc 'error'
  // covers spawn failure (binary not found) — the old json driver resolved 1.
  proc.stdin.on("error", () => {});
  proc.stdout.on("error", () => {});
  proc.stderr.on("error", () => {});
  proc.on("error", () => fireClose(1));
  proc.on("close", (code) => fireClose(code ?? 1));

  return {
    write: (line: string) => proc.stdin.write(line + "\n"),
    onLine: (cb) => lineCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    kill: () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!closed) proc.kill("SIGKILL");
      }, 5000);
    },
  };
}

async function gateChildReport(
  result: SingleResult,
  session: ChildSession,
  onUpdate: ChildUpdate | undefined,
): Promise<void> {
  const emitUpdate = () => onUpdate?.(result);

  const rawReport = getFinalOutput(result.messages);
  if (rawReport === "") {
    result.finalReport = "";
    return;
  }

  const compress = async (report: string): Promise<string> => {
    const r = await session.sendPrompt(compressPrompt(report));
    emitUpdate();
    if (!r.settled) throw new Error("compress turn did not settle");
    return getFinalOutput(result.messages);
  };

  let gated: { report: string; verdict: ReportAssessment };
  try {
    gated = await gateReport(rawReport, undefined, compress);
  } catch (e) {
    const { report: body, omitted } = hardTruncateReport(rawReport);
    gated = { report: body, verdict: { kind: "truncated", bytes: omitted } };
    result.stderr += `\n[compress bounce failed: ${e instanceof Error ? e.message : String(e)}; fell back to hard-truncate]`;
  }

  result.finalReport =
    gated.verdict.kind === "truncated"
      ? `${gated.report}\n\n${truncationNotice(gated.verdict.bytes)}`
      : gated.report;
}

interface SpawnContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    confirm: (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) => Promise<boolean>;
    select: (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>;
    input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }) => Promise<string | undefined>;
    editor: (title: string, prefill?: string) => Promise<string | undefined>;
    notify: (message: string, type?: "info" | "warning" | "error") => void;
  };
}

async function runChild(
  ctx: SpawnContext,
  task: string,
  model: string,
  signal: AbortSignal | undefined,
  onUpdate: ChildUpdate | undefined,
  gate: DialogGate,
): Promise<SingleResult> {
  const depthEnv = String(childDepthOf(currentDepth()));
  const result: SingleResult = {
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model,
  };

  const emitUpdate = () => onUpdate?.(result);

  const forwarder: UiForwarder = {
    hasUI: ctx.hasUI,
    confirm: (t, m, o) => ctx.ui.confirm(t, m, o),
    select: (t, o, s) => ctx.ui.select(t, o, s),
    input: (t, p, o) => ctx.ui.input(t, p, o),
    editor: (t, p) => ctx.ui.editor(t, p),
    notify: (m, ty) => ctx.ui.notify(m, ty),
  };

  const transport = spawnRpcTransport(ctx.cwd, model, depthEnv, (s) => {
    result.stderr += s;
  });
  const session = new ChildSession(transport, forwarder, result, emitUpdate, signal, gate);

  try {
    const t = await session.sendPrompt(`Task: ${task}`);
    result.exitCode = t.exitCode;
    result.settled = t.settled;
    if (t.aborted) throw new Error("Spawned child was aborted");
    if (!t.settled) result.errorMessage ??= `child exited (code ${t.exitCode}) before completing its turn`;

    if (!isFailedResult(result)) {
      await gateChildReport(result, session, onUpdate);
    }
  } finally {
    session.close();
  }
  return result;
}

const COMPLEXITY_DESCRIPTION = [
  "Task difficulty; the extension resolves the child model from it.",
  "Required — in single mode alongside task, and on every item in tasks.",
  "trivial — mechanical, zero judgment: rename, typo, apply stated pattern verbatim.",
  "easy — one obvious change, approach clear before starting, single file/function.",
  "medium — several steps, minor exploration needed, approach settles after a quick look.",
  "hard — design judgment, multi-step debugging, or synthesis across components.",
].join(" ");

const complexityParam = () =>
  Type.Union(
    [Type.Literal("trivial"), Type.Literal("easy"), Type.Literal("medium"), Type.Literal("hard")],
    { description: COMPLEXITY_DESCRIPTION },
  );

const TaskItem = Type.Object({
  task: Type.String({ description: "Task to delegate to the child" }),
  complexity: complexityParam(),
});

const SpawnParams = Type.Object({
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  complexity: Type.Optional(complexityParam()),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {task, complexity} for parallel execution" })),
});

export function register(pi: ExtensionAPI): void {
  if (!canSpawn(currentDepth())) return;

  const dialogGate = new DialogGate();

  pi.registerTool({
    name: "spawn",
    label: "Spawn",
    description: [
      "Spawn a child pi process per task with an isolated context window; the child's report lands here.",
      "Modes: single (task) or parallel (tasks array). Provide exactly one.",
    ].join(" "),
    parameters: SpawnParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const selection = selectMode(params);
      if (selection.kind === "error") {
        return {
          content: [{ type: "text", text: selection.message }],
          details: makeDetails("single")([]),
        };
      }

      let complexityMap: ComplexityMap;
      try {
        complexityMap = loadComplexityMap();
      } catch (e) {
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          details: makeDetails(selection.kind)([]),
          isError: true,
        };
      }

      if (selection.kind === "parallel") {
        const tasks = params.tasks!;
        const allResults: SingleResult[] = tasks.map((t) => ({
          task: t.task,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: emptyUsage(),
          model: complexityMap[t.complexity],
        }));

        const emitParallelUpdate = () => {
          if (!onUpdate) return;
          const running = allResults.filter((r) => r.exitCode === -1).length;
          const done = allResults.filter((r) => r.exitCode !== -1).length;
          onUpdate({
            content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
            details: makeDetails("parallel")([...allResults]),
          });
        };

        const results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (t, index) => {
          const result = await runChild(
            ctx,
            t.task,
            complexityMap[t.complexity],
            signal,
            (r) => {
              allResults[index] = r;
              emitParallelUpdate();
            },
            dialogGate,
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
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
            {
              type: "text",
              text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
            },
          ],
          details: makeDetails("parallel")(results),
        };
      }

      const childUpdate: ChildUpdate | undefined = onUpdate
        ? (r) =>
            onUpdate({
              content: [{ type: "text", text: getFinalOutput(r.messages) || "(running...)" }],
              details: makeDetails("single")([r]),
            })
        : undefined;

      const result = await runChild(ctx, params.task!, complexityMap[params.complexity!], signal, childUpdate, dialogGate);
      if (isFailedResult(result)) {
        return {
          content: [{ type: "text", text: `Child ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
          details: makeDetails("single")([result]),
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: result.finalReport || getFinalOutput(result.messages) || "(no output)" }],
        details: makeDetails("single")([result]),
      };
    },

    renderCall(args, theme, _context) {
      if (args.tasks && args.tasks.length > 0) {
        let text =
          theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
        for (const t of args.tasks.slice(0, 3)) {
          text += `\n  ${theme.fg("dim", taskPreview(t.task, 40))}`;
        }
        if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const preview = args.task ? taskPreview(args.task, 60) : "...";
      const text = `${theme.fg("toolTitle", theme.bold("spawn "))}${theme.fg("accent", "single")}\n  ${theme.fg("dim", preview)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        const isError = isFailedResult(r);
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        const finalOutput = r.finalReport ?? getFinalOutput(r.messages);

        if (expanded) {
          const container = new Container();
          let header = `${icon} ${theme.fg("toolTitle", theme.bold(taskPreview(r.task)))}`;
          if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && r.errorMessage)
            container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
          container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
          if (displayItems.length === 0 && !finalOutput) {
            container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
          } else {
            for (const item of displayItems) {
              if (item.type === "toolCall")
                container.addChild(
                  new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
                );
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
            }
          }
          const usageStr = formatUsageStats(r.usage, r.model);
          if (usageStr) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
          }
          return container;
        }

        let text = `${icon} ${theme.fg("toolTitle", theme.bold(taskPreview(r.task)))}`;
        if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
        if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
        else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
        else {
          text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        return new Text(text, 0, 0);
      }

      const running = details.results.filter((r) => r.exitCode === -1).length;
      const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
      const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
      const isRunning = running > 0;
      const icon = isRunning
        ? theme.fg("warning", "⏳")
        : failCount > 0
          ? theme.fg("warning", "◐")
          : theme.fg("success", "✓");
      const status = isRunning
        ? `${successCount + failCount}/${details.results.length} done, ${running} running`
        : `${successCount}/${details.results.length} tasks`;

      if (expanded && !isRunning) {
        const container = new Container();
        container.addChild(
          new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
        );

        for (const r of details.results) {
          const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
          const displayItems = getDisplayItems(r.messages);
          const finalOutput = r.finalReport ?? getFinalOutput(r.messages);

          container.addChild(new Spacer(1));
          container.addChild(new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", taskPreview(r.task))} ${rIcon}`, 0, 0));

          for (const item of displayItems) {
            if (item.type === "toolCall") {
              container.addChild(
                new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
              );
            }
          }

          if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
          }

          const taskUsage = formatUsageStats(r.usage, r.model);
          if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
        }

        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
        }
        return container;
      }

      let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
      for (const r of details.results) {
        const rIcon =
          r.exitCode === -1
            ? theme.fg("warning", "⏳")
            : isFailedResult(r)
              ? theme.fg("error", "✗")
              : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", taskPreview(r.task))} ${rIcon}`;
        if (displayItems.length === 0) text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
        else text += `\n${renderDisplayItems(displayItems, 5)}`;
      }
      if (!isRunning) {
        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
      }
      text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      return new Text(text, 0, 0);
    },
  });
}

export default register;
