import type { Message } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;
export const REPORT_CAP = 4096;
export const MAX_DEPTH = 1;

export function currentDepth(): number {
  const parsed = Number(process.env.LIUBAI_SPAWN_DEPTH);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

export function childDepthOf(parentDepth: number): number {
  return parentDepth + 1;
}

export function canSpawn(depth: number): boolean {
  return depth < MAX_DEPTH;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  finalReport?: string;
  settled?: boolean;
}

export const COMPLEXITY_LEVELS = ["trivial", "easy", "medium", "hard"] as const;
export type Complexity = (typeof COMPLEXITY_LEVELS)[number];

function isComplexity(value: unknown): value is Complexity {
  return COMPLEXITY_LEVELS.includes(value as Complexity);
}

const COMPLEXITY_EXAMPLE = "config/complexity.example.json";

export function defaultComplexityConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "complexity.json");
}

export type ComplexityMap = Record<Complexity, string>;

export function loadComplexityMap(configPath: string = defaultComplexityConfigPath()): ComplexityMap {
  const remedy = `Copy ${COMPLEXITY_EXAMPLE} from the repo to ${configPath} and fill in real model ids.`;

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`Complexity config not found at ${configPath}. ${remedy}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Complexity config at ${configPath} is not valid JSON. ${remedy}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Complexity config at ${configPath} must be a flat object. ${remedy}`);
  }

  const entries = parsed as Record<string, unknown>;
  for (const key of Object.keys(entries)) {
    if (!isComplexity(key)) {
      throw new Error(`Complexity config at ${configPath} has unknown key "${key}". Allowed keys: ${COMPLEXITY_LEVELS.join(", ")}. ${remedy}`);
    }
  }
  for (const level of COMPLEXITY_LEVELS) {
    const value = entries[level];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Complexity config at ${configPath} needs a non-empty model id string for "${level}". ${remedy}`);
    }
  }
  return entries as ComplexityMap;
}

export type ModeSelection = { kind: "single" } | { kind: "parallel" } | { kind: "error"; message: string };

export function selectMode(params: {
  task?: string;
  complexity?: string;
  tasks?: { task: string; complexity?: string }[];
}): ModeSelection {
  const hasSingle = Boolean(params.task && params.task.trim());
  const hasParallel = (params.tasks?.length ?? 0) > 0;

  if (hasSingle && hasParallel) {
    return { kind: "error", message: "Provide exactly one of task or tasks, not both." };
  }
  if (!hasSingle && !hasParallel) {
    return { kind: "error", message: "Provide either a task or a tasks array." };
  }
  if (hasParallel && params.tasks!.length > MAX_PARALLEL_TASKS) {
    return { kind: "error", message: `Too many parallel tasks (${params.tasks!.length}). Max is ${MAX_PARALLEL_TASKS}.` };
  }

  const complexityError = (value: unknown) =>
    ({
      kind: "error",
      message: `complexity is required and must be one of ${COMPLEXITY_LEVELS.join(" | ")} (got ${JSON.stringify(value)}).`,
    }) as const;

  if (hasSingle && !isComplexity(params.complexity)) return complexityError(params.complexity);
  if (hasParallel) {
    for (const t of params.tasks!) {
      if (!isComplexity(t.complexity)) return complexityError(t.complexity);
    }
  }
  return hasParallel ? { kind: "parallel" } : { kind: "single" };
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: any, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export function isFailedResult(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.settled === false ||
    result.stopReason === "error" ||
    result.stopReason === "aborted"
  );
}

// Failure output skips the compress bounce (no live child to ask), so the cap
// is enforced by hard truncation — a crashing child's stderr flood must not
// land uncapped in the parent's context.
export function getResultOutput(result: SingleResult): string {
  if (!isFailedResult(result)) {
    return getFinalOutput(result.messages) || "(no output)";
  }
  const raw = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  const { report, omitted } = hardTruncateReport(raw);
  return omitted > 0 ? `${report}\n\n${truncationNotice(omitted)}` : report;
}

export type ReportAssessment =
  | { kind: "accepted" }
  | { kind: "needs_compress"; bytes: number }
  | { kind: "truncated"; bytes: number };

export function assessReport(report: string): ReportAssessment {
  const bytes = Buffer.byteLength(report, "utf8");
  if (bytes <= REPORT_CAP) return { kind: "accepted" };
  return { kind: "needs_compress", bytes };
}

export function truncationNotice(omitted: number): string {
  return `[report truncated: ${omitted} bytes over ${REPORT_CAP / 1024} KB cap]`;
}

export function hardTruncateReport(report: string): { report: string; omitted: number } {
  const byteLength = Buffer.byteLength(report, "utf8");
  if (byteLength <= REPORT_CAP) return { report, omitted: 0 };

  let truncated = report.slice(0, REPORT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > REPORT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return { report: truncated, omitted: byteLength - Buffer.byteLength(truncated, "utf8") };
}

export async function gateReport(
  report: string,
  compressed: string | undefined,
  compress: (report: string) => Promise<string>,
): Promise<{ report: string; verdict: ReportAssessment }> {
  const initial = assessReport(report);
  if (initial.kind === "accepted") return { report, verdict: initial };

  if (compressed === undefined) {
    const attempt = await compress(report);
    const rechecked = assessReport(attempt);
    if (rechecked.kind === "accepted") return { report: attempt, verdict: rechecked };
    const { report: truncated, omitted } = hardTruncateReport(attempt);
    return { report: truncated, verdict: { kind: "truncated", bytes: omitted } };
  }

  const { report: truncated, omitted } = hardTruncateReport(report);
  return { report: truncated, verdict: { kind: "truncated", bytes: omitted } };
}

export function compressPrompt(report: string): string {
  const bytes = Buffer.byteLength(report, "utf8");
  return [
    `Your previous report is ${bytes} bytes, which exceeds the ${REPORT_CAP}-byte (${REPORT_CAP / 1024} KB) cap.`,
    "Rewrite it under 4096 bytes (UTF-8), preserving the essential findings, conclusions, and code references while dropping redundancy and detail that is not load-bearing.",
    "Output ONLY the compressed report. No preamble, no commentary, no explanation of what you changed.",
  ].join(" ");
}

export function taskPreview(task: string, max = 40): string {
  const clean = task.trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") items.push({ type: "text", text: part.text });
        else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

export function aggregateUsage(results: SingleResult[]): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
} {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.turns += r.usage.turns;
  }
  return total;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}
