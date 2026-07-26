import type { ThemeColor } from "@earendil-works/pi-coding-agent";

import {
  COLLAPSED_ITEM_COUNT,
  aggregateUsage,
  formatToolCall,
  formatUsageStats,
  getDisplayItems,
  getFinalOutput,
  isFailedResult,
  taskPreview,
  type DisplayItem,
  type SingleResult,
  type SubagentDetails,
} from "./child.ts";

const PARALLEL_COLLAPSED_ITEM_COUNT = 5;

export interface ViewTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

export type ViewNode = { kind: "text"; text: string } | { kind: "spacer" } | { kind: "markdown"; text: string };

export interface RenderedResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

export interface CallArgs {
  task?: string;
  tasks?: { task: string }[];
}

const text = (value: string): ViewNode => ({ kind: "text", text: value });
const spacer = (): ViewNode => ({ kind: "spacer" });
const markdown = (value: string): ViewNode => ({ kind: "markdown", text: value });
const blankLine = () => text("");

const outcomeIcon = (result: SingleResult, theme: ViewTheme) =>
  isFailedResult(result) ? theme.fg("error", "✗") : theme.fg("success", "✓");

const toolCallLine = (item: Extract<DisplayItem, { type: "toolCall" }>, theme: ViewTheme) =>
  theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, (color, value) => theme.fg(color, value));

const finalReportOf = (result: SingleResult) => result.finalReport ?? getFinalOutput(result.messages);

function displayItemLines(items: DisplayItem[], limit: number, expanded: boolean, theme: ViewTheme): string {
  const shown = items.slice(-limit);
  const skipped = items.length > limit ? items.length - limit : 0;
  let out = "";
  if (skipped > 0) out += theme.fg("muted", `... ${skipped} earlier items\n`);
  for (const item of shown) {
    if (item.type === "text") {
      const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
      out += `${theme.fg("toolOutput", preview)}\n`;
    } else {
      out += `${toolCallLine(item, theme)}\n`;
    }
  }
  return out.trimEnd();
}

const capabilityLine = (result: SingleResult): string | undefined =>
  result.notes?.length ? `⚠ ${result.notes.join("; ")}` : undefined;

function singleExpanded(result: SingleResult, theme: ViewTheme): ViewNode[] {
  const failed = isFailedResult(result);
  const items = getDisplayItems(result.messages);
  const report = finalReportOf(result);

  let header = `${outcomeIcon(result, theme)} ${theme.fg("toolTitle", theme.bold(taskPreview(result.task)))}`;
  if (failed && result.stopReason) header += ` ${theme.fg("error", `[${result.stopReason}]`)}`;

  const nodes = [text(header)];
  if (failed && result.errorMessage) nodes.push(text(theme.fg("error", `Error: ${result.errorMessage}`)));
  nodes.push(spacer(), text(theme.fg("muted", "─── Task ───")), text(theme.fg("dim", result.task)));
  nodes.push(spacer(), text(theme.fg("muted", "─── Output ───")));

  if (items.length === 0 && !report) {
    nodes.push(text(theme.fg("muted", "(no output)")));
  } else {
    for (const item of items) if (item.type === "toolCall") nodes.push(text(toolCallLine(item, theme)));
    if (report) nodes.push(spacer(), markdown(report.trim()));
  }

  const usage = formatUsageStats(result.usage, result.model);
  if (usage) nodes.push(spacer(), text(theme.fg("dim", usage)));

  const lost = capabilityLine(result);
  if (lost) nodes.push(text(theme.fg("warning", lost)));
  return nodes;
}

function singleCollapsed(result: SingleResult, theme: ViewTheme): ViewNode[] {
  const failed = isFailedResult(result);
  const items = getDisplayItems(result.messages);

  let out = `${outcomeIcon(result, theme)} ${theme.fg("toolTitle", theme.bold(taskPreview(result.task)))}`;
  if (failed && result.stopReason) out += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
  if (failed && result.errorMessage) out += `\n${theme.fg("error", `Error: ${result.errorMessage}`)}`;
  else if (items.length === 0) out += `\n${theme.fg("muted", "(no output)")}`;
  else {
    out += `\n${displayItemLines(items, COLLAPSED_ITEM_COUNT, false, theme)}`;
    if (items.length > COLLAPSED_ITEM_COUNT) out += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  }

  const usage = formatUsageStats(result.usage, result.model);
  if (usage) out += `\n${theme.fg("dim", usage)}`;

  const lost = capabilityLine(result);
  if (lost) out += `\n${theme.fg("warning", lost)}`;
  return [text(out)];
}

interface BatchStatus {
  running: number;
  isRunning: boolean;
  icon: string;
  label: string;
}

function batchStatus(results: SingleResult[], theme: ViewTheme): BatchStatus {
  const running = results.filter((r) => r.exitCode === -1).length;
  const succeeded = results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
  const failed = results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
  const isRunning = running > 0;
  return {
    running,
    isRunning,
    icon: isRunning
      ? theme.fg("warning", "⏳")
      : failed > 0
        ? theme.fg("warning", "◐")
        : theme.fg("success", "✓"),
    label: isRunning ? `${succeeded + failed}/${results.length} done, ${running} running` : `${succeeded}/${results.length} tasks`,
  };
}

const batchHeader = (status: BatchStatus, theme: ViewTheme) =>
  `${status.icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status.label)}`;

function parallelExpanded(results: SingleResult[], theme: ViewTheme): ViewNode[] {
  const nodes = [text(batchHeader(batchStatus(results, theme), theme))];

  for (const result of results) {
    const items = getDisplayItems(result.messages);
    const report = finalReportOf(result);

    nodes.push(spacer());
    nodes.push(
      text(`${theme.fg("muted", "─── ") + theme.fg("accent", taskPreview(result.task))} ${outcomeIcon(result, theme)}`),
    );
    for (const item of items) if (item.type === "toolCall") nodes.push(text(toolCallLine(item, theme)));
    if (report) nodes.push(spacer(), markdown(report.trim()));

    const usage = formatUsageStats(result.usage, result.model);
    if (usage) nodes.push(text(theme.fg("dim", usage)));

    const lost = capabilityLine(result);
    if (lost) nodes.push(text(theme.fg("warning", lost)));
  }

  const total = formatUsageStats(aggregateUsage(results));
  if (total) nodes.push(spacer(), text(theme.fg("dim", `Total: ${total}`)));
  return nodes;
}

function parallelCollapsed(results: SingleResult[], expanded: boolean, theme: ViewTheme): ViewNode[] {
  const status = batchStatus(results, theme);
  const nodes = [text(batchHeader(status, theme))];

  for (const result of results) {
    const icon =
      result.exitCode === -1 ? theme.fg("warning", "⏳") : outcomeIcon(result, theme);
    const items = getDisplayItems(result.messages);

    let section = `${theme.fg("muted", "─── ")}${theme.fg("accent", taskPreview(result.task))} ${icon}`;
    if (items.length === 0) {
      section += `\n${theme.fg("muted", result.exitCode === -1 ? "(running...)" : "(no output)")}`;
    } else {
      section += `\n${displayItemLines(items, PARALLEL_COLLAPSED_ITEM_COUNT, expanded, theme)}`;
    }
    nodes.push(blankLine(), text(section));
  }

  if (!status.isRunning) {
    const total = formatUsageStats(aggregateUsage(results));
    if (total) nodes.push(blankLine(), text(theme.fg("dim", `Total: ${total}`)));
  }
  nodes.push(text(theme.fg("muted", "(Ctrl+O to expand)")));
  return nodes;
}

export function describeResult(result: RenderedResult, expanded: boolean, theme: ViewTheme): ViewNode[] {
  const details = result.details as SubagentDetails | undefined;
  if (!details || details.results.length === 0) {
    const part = result.content[0];
    return [text(part?.type === "text" ? (part.text ?? "") : "(no output)")];
  }

  const [first] = details.results;
  if (first && details.mode === "single" && details.results.length === 1) {
    return expanded ? singleExpanded(first, theme) : singleCollapsed(first, theme);
  }

  const isRunning = details.results.some((r) => r.exitCode === -1);
  return expanded && !isRunning
    ? parallelExpanded(details.results, theme)
    : parallelCollapsed(details.results, expanded, theme);
}

export function describeCall(args: CallArgs, theme: ViewTheme): ViewNode[] {
  if (args.tasks && args.tasks.length > 0) {
    let out = theme.fg("toolTitle", theme.bold("spawn ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
    for (const t of args.tasks.slice(0, 3)) out += `\n  ${theme.fg("dim", taskPreview(t.task, 40))}`;
    if (args.tasks.length > 3) out += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
    return [text(out)];
  }

  const preview = args.task ? taskPreview(args.task, 60) : "...";
  return [
    text(`${theme.fg("toolTitle", theme.bold("spawn "))}${theme.fg("accent", "single")}\n  ${theme.fg("dim", preview)}`),
  ];
}
