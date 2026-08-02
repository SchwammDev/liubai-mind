import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;
export const REPORT_CAP = 4096;
export const MAX_DEPTH = 1;

export const CLARIFY_TAG = "\x00CLARIFY:";
export const QUESTION_CAP = 4096;
export const MAX_CLARIFY = 2;
export const CLARIFY_TIMEOUT_MS = 15 * 60 * 1000;

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
  notes?: string[];
  stopReason?: string;
  errorMessage?: string;
  finalReport?: string;
  settled?: boolean;
  profile?: string;
}

export type SpawnMode = "single" | "parallel";

export interface SubagentDetails {
  mode: SpawnMode;
  results: SingleResult[];
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

export interface ComplexitySelection {
  profile: string;
  map: ComplexityMap;
}

export function defaultActiveProfilePath(): string {
  return path.join(os.homedir(), ".pi", "agent", "active-profile.json");
}

export function loadProfilesRaw(configPath: string = defaultComplexityConfigPath()): unknown {
  const remedy = `Copy ${COMPLEXITY_EXAMPLE} from the repo to ${configPath} and fill in real model ids.`;
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`Complexity config not found at ${configPath}. ${remedy}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Complexity config at ${configPath} is not valid JSON. ${remedy}`);
  }
}

export function extractProfiles(parsed: unknown): Record<string, unknown> | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const profiles = obj["profiles"];
  if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) return null;
  return profiles as Record<string, unknown>;
}

function unknownProfileKey(name: string, keys: string[]): string | undefined {
  const expected = new Set<string>(COMPLEXITY_LEVELS);
  for (const key of keys) {
    if (!expected.has(key)) {
      return `Profile "${name}" has unknown key "${key}". Allowed keys: ${COMPLEXITY_LEVELS.join(", ")}.`;
    }
  }
  return undefined;
}

function missingLevelModelId(name: string, obj: Record<string, unknown>): string | undefined {
  for (const level of COMPLEXITY_LEVELS) {
    const value = obj[level];
    if (typeof value !== "string" || value.trim() === "") {
      return `Profile "${name}" needs a non-empty model id string for "${level}".`;
    }
  }
  return undefined;
}

export function validateProfile(name: string, raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `Profile "${name}" must be an object.`;
  }
  const obj = raw as Record<string, unknown>;
  return unknownProfileKey(name, Object.keys(obj)) ?? missingLevelModelId(name, obj);
}

const TARGET_SHAPE = `Expected shape: { "profiles": { "<name>": { ${COMPLEXITY_LEVELS.join(", ")} } } }. Copy ${COMPLEXITY_EXAMPLE} from the repo as a starting point.`;

export function validateProfilesConfig(parsed: unknown): string[] {
  const profiles = extractProfiles(parsed);
  if (profiles === null) {
    return [`Complexity config is a flat object. ${TARGET_SHAPE}`];
  }
  const problems: string[] = [];
  for (const name of Object.keys(profiles)) {
    const problem = validateProfile(name, profiles[name]);
    if (problem) problems.push(problem);
  }
  return problems;
}

export function firstProfileName(profiles: Record<string, unknown>): string | undefined {
  const names = Object.keys(profiles);
  return names.length > 0 ? names[0] : undefined;
}

function readActiveProfileRaw(profilePath: string): string | undefined {
  try {
    return fs.readFileSync(profilePath, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return undefined;
    throw e;
  }
}

function requireProfileName(parsed: unknown, profilePath: string): string {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Active profile config at ${profilePath} must be an object.`);
  }
  const profile = (parsed as Record<string, unknown>)["profile"];
  if (typeof profile !== "string" || profile.trim() === "") {
    throw new Error(`Active profile config at ${profilePath} needs a "profile" string.`);
  }
  return profile;
}

export function loadActiveProfileName(profilePath: string = defaultActiveProfilePath()): string | undefined {
  const raw = readActiveProfileRaw(profilePath);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Active profile config at ${profilePath} is not valid JSON.`);
  }
  return requireProfileName(parsed, profilePath);
}

export function loadComplexitySelection(
  configPath: string = defaultComplexityConfigPath(),
  profilePath: string = defaultActiveProfilePath(),
): ComplexitySelection {
  const parsed = loadProfilesRaw(configPath);
  const profiles = extractProfiles(parsed);
  if (profiles === null) {
    throw new Error(`Complexity config at ${configPath} is a flat object. ${TARGET_SHAPE}`);
  }

  const profileNames = Object.keys(profiles);
  if (profileNames.length === 0) {
    throw new Error(`Complexity config at ${configPath} defines no profiles. ${TARGET_SHAPE}`);
  }

  const activeName = loadActiveProfileName(profilePath) ?? firstProfileName(profiles)!;
  if (!(activeName in profiles)) {
    throw new Error(
      `Active profile "${activeName}" is not defined in ${configPath}. Available profiles: ${profileNames.join(", ")}.`,
    );
  }

  const activeProblem = validateProfile(activeName, profiles[activeName]);
  if (activeProblem) {
    throw new Error(`${activeProblem}`);
  }

  const map = profiles[activeName] as ComplexityMap;
  return { profile: activeName, map };
}

export type ModeSelection = { kind: "single" } | { kind: "parallel" } | { kind: "error"; message: string };

function modeShapeError(hasSingle: boolean, hasParallel: boolean, taskCount: number): string | undefined {
  if (hasSingle && hasParallel) return "Provide exactly one of task or tasks, not both.";
  if (!hasSingle && !hasParallel) return "Provide either a task or a tasks array.";
  if (hasParallel && taskCount > MAX_PARALLEL_TASKS) {
    return `Too many parallel tasks (${taskCount}). Max is ${MAX_PARALLEL_TASKS}.`;
  }
  return undefined;
}

function firstComplexityError(
  params: { complexity?: string; tasks?: { task: string; complexity?: string }[] },
  hasSingle: boolean,
  hasParallel: boolean,
): ModeSelection | undefined {
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
  return undefined;
}

export function selectMode(params: {
  task?: string;
  complexity?: string;
  tasks?: { task: string; complexity?: string }[];
}): ModeSelection {
  const hasSingle = Boolean(params.task && params.task.trim());
  const taskCount = params.tasks?.length ?? 0;
  const hasParallel = taskCount > 0;

  const shapeError = modeShapeError(hasSingle, hasParallel, taskCount);
  if (shapeError) return { kind: "error", message: shapeError };

  const complexityProblem = firstComplexityError(params, hasSingle, hasParallel);
  if (complexityProblem) return complexityProblem;

  return hasParallel ? { kind: "parallel" } : { kind: "single" };
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function tokenUsageParts(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns?: number;
}): string[] {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  return parts;
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
  const parts = tokenUsageParts(usage);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

type ThemeFg = (color: ThemeColor, text: string) => string;
type ToolCallFormatter = (args: Record<string, unknown>, fg: ThemeFg) => string;

function shortenHomePath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function argPath(args: Record<string, unknown>): string {
  return shortenHomePath((args.file_path || args.path || "...") as string);
}

function formatBashCall(args: Record<string, unknown>, fg: ThemeFg): string {
  const command = (args.command as string) || "...";
  const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
  return fg("muted", "$ ") + fg("toolOutput", preview);
}

function formatReadCall(args: Record<string, unknown>, fg: ThemeFg): string {
  const offset = args.offset as number | undefined;
  const limit = args.limit as number | undefined;
  let text = fg("accent", argPath(args));
  if (offset !== undefined || limit !== undefined) {
    const startLine = offset ?? 1;
    const endLine = limit !== undefined ? startLine + limit - 1 : "";
    text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
  }
  return fg("muted", "read ") + text;
}

function formatWriteCall(args: Record<string, unknown>, fg: ThemeFg): string {
  const content = (args.content || "") as string;
  const lines = content.split("\n").length;
  let text = fg("muted", "write ") + fg("accent", argPath(args));
  if (lines > 1) text += fg("dim", ` (${lines} lines)`);
  return text;
}

function formatEditCall(args: Record<string, unknown>, fg: ThemeFg): string {
  return fg("muted", "edit ") + fg("accent", argPath(args));
}

function formatLsCall(args: Record<string, unknown>, fg: ThemeFg): string {
  const rawPath = (args.path || ".") as string;
  return fg("muted", "ls ") + fg("accent", shortenHomePath(rawPath));
}

function formatFindCall(args: Record<string, unknown>, fg: ThemeFg): string {
  const pattern = (args.pattern || "*") as string;
  const rawPath = (args.path || ".") as string;
  return fg("muted", "find ") + fg("accent", pattern) + fg("dim", ` in ${shortenHomePath(rawPath)}`);
}

function formatGrepCall(args: Record<string, unknown>, fg: ThemeFg): string {
  const pattern = (args.pattern || "") as string;
  const rawPath = (args.path || ".") as string;
  return fg("muted", "grep ") + fg("accent", `/${pattern}/`) + fg("dim", ` in ${shortenHomePath(rawPath)}`);
}

function formatUnknownCall(toolName: string, args: Record<string, unknown>, fg: ThemeFg): string {
  const argsStr = JSON.stringify(args);
  const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
  return fg("accent", toolName) + fg("dim", ` ${preview}`);
}

const TOOL_CALL_FORMATTERS: Record<string, ToolCallFormatter> = {
  bash: formatBashCall,
  read: formatReadCall,
  write: formatWriteCall,
  edit: formatEditCall,
  ls: formatLsCall,
  find: formatFindCall,
  grep: formatGrepCall,
};

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
): string {
  const formatter = TOOL_CALL_FORMATTERS[toolName];
  return formatter ? formatter(args, themeFg) : formatUnknownCall(toolName, args, themeFg);
}

export function getFinalOutput(messages: Message[]): string {
  for (const msg of messages.toReversed()) {
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

function failureReport(result: SingleResult): string {
  const diagnosis = [result.errorMessage, result.stderr]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n");
  return diagnosis || getFinalOutput(result.messages);
}

// Failure output skips the compress bounce (no live child to ask), so the cap
// is enforced by hard truncation — a crashing child's stderr flood must not
// land uncapped in the parent's context.
export function getResultOutput(result: SingleResult): string {
  if (!isFailedResult(result)) {
    return getFinalOutput(result.messages) || "(no output)";
  }
  const raw = failureReport(result) || "(no output)";
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

export type QuestionAssessment = { kind: "accepted" } | { kind: "rejected"; bytes: number };

export function assessQuestion(question: string): QuestionAssessment {
  const bytes = Buffer.byteLength(question, "utf8");
  if (bytes <= QUESTION_CAP) return { kind: "accepted" };
  return { kind: "rejected", bytes };
}

export function buildClarifyTitle(question: string): string {
  return CLARIFY_TAG + question;
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
  const pending = [...items.entries()];
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const next = pending[nextIndex++];
      if (next === undefined) return;
      const [index, item] = next;
      results[index] = await fn(item, index);
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
