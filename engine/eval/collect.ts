import { mkdirSync, mkdtempSync, existsSync, readFileSync, appendFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { CaseManifest, ConditionManifest, RawRow, Tier } from "./eval-contract.ts";
import { RULE } from "../contract.ts";
import type { RuleName } from "../contract.ts";
import { loadConditions } from "./conditions.ts";
import { loadCases, copyPlan } from "./corpus.ts";
import { buildProvenance } from "./provenance.ts";
import { defaultPiSpawner } from "./spawner.ts";
import type { PiSpawner, RunOutcome } from "./spawner.ts";
import { snapshotExtras } from "./snapshot.ts";
import type { WorkDirSnapshot } from "./snapshot.ts";

export interface CollectOpts {
  repoRoot: string;
  runDir: string;
  reps: number;
  model: string;
  timeoutMs?: number;
  cases?: string[];
  conditions?: string[];
  tier?: Tier;
  spawner?: PiSpawner;
  workRoot?: string;
  now?: () => string;
  conditionsDir?: string;
  corpusDir?: string;
  parallel?: number;
}

export interface CollectResult {
  status: number;
  rowsWritten: number;
  rowsSkipped: number;
  stderr: string;
}

interface WorkItem {
  kase: CaseManifest;
  condition: ConditionManifest;
  rep: number;
}

export interface CollectContext {
  repoRoot: string;
  corpusDir: string;
  conditionsDir: string;
  model: string;
  timeoutMs: number;
  spawner: PiSpawner;
  workRoot: string;
  now: () => string;
  parallel: number;
}

export interface ItemResult {
  row?: RawRow;
  stdoutJsonl?: string;
  failure?: string;
}

const DEFAULT_TIMEOUT_MS = 900000;
const FALLBACK_AGENT_ERROR = "agent error";

interface AutoRetryEndEvent {
  type: "auto_retry_end";
  success: boolean;
  finalError?: string;
}

function parseAutoRetryEnd(line: string): AutoRetryEndEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "auto_retry_end" || typeof obj.success !== "boolean") return undefined;

  const finalError = typeof obj.finalError === "string" ? obj.finalError : undefined;
  return { type: "auto_retry_end", success: obj.success, ...(finalError !== undefined ? { finalError } : {}) };
}

interface AssistantEnd {
  stopReason?: string;
  errorMessage?: string;
}

function assistantMessageOf(line: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "message_end" || typeof obj.message !== "object" || obj.message === null) return undefined;

  const message = obj.message as Record<string, unknown>;
  return message.role === "assistant" ? message : undefined;
}

function parseAssistantMessageEnd(line: string): AssistantEnd | undefined {
  const message = assistantMessageOf(line);
  if (message === undefined) return undefined;
  return {
    ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
    ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
  };
}

function nonEmptyLines(stdoutJsonl: string): string[] {
  return stdoutJsonl.split("\n").filter((line) => line.trim().length > 0);
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function countTurns(stdoutJsonl: string): number {
  let turns = 0;
  for (const line of nonEmptyLines(stdoutJsonl)) {
    const parsed = parseJsonLine(line);
    if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).type === "turn_start") turns += 1;
  }
  return turns;
}

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
}

function numberField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" ? value : 0;
}

export function sumTokenUsage(stdoutJsonl: string): TokenUsage {
  const usage: TokenUsage = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0 };

  for (const line of nonEmptyLines(stdoutJsonl)) {
    const message = assistantMessageOf(line);
    if (message === undefined || typeof message.usage !== "object" || message.usage === null) continue;

    const messageUsage = message.usage as Record<string, unknown>;
    usage.tokensIn += numberField(messageUsage, "input");
    usage.tokensOut += numberField(messageUsage, "output");
    usage.cacheReadTokens += numberField(messageUsage, "cacheRead");
  }

  return usage;
}

const RULE_NAMES: readonly RuleName[] = Object.values(RULE);

function emptyRailFirings(): Record<RuleName, number> {
  return Object.fromEntries(RULE_NAMES.map((rule) => [rule, 0])) as Record<RuleName, number>;
}

function toolExecutionEndResultOf(line: string): Record<string, unknown> | undefined {
  const parsed = parseJsonLine(line);
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "tool_execution_end" || typeof obj.result !== "object" || obj.result === null) return undefined;

  return obj.result as Record<string, unknown>;
}

function textPartOf(part: unknown): string | undefined {
  if (typeof part !== "object" || part === null) return undefined;

  const { type, text } = part as Record<string, unknown>;
  return type === "text" && typeof text === "string" ? text : undefined;
}

function toolResultTexts(line: string): string[] {
  const result = toolExecutionEndResultOf(line);
  const content = result?.content;
  if (!Array.isArray(content)) return [];

  return content.map(textPartOf).filter((text): text is string => text !== undefined);
}

function countRuleMarkersIn(text: string, marker: string): number {
  let count = 0;
  let index = text.indexOf(marker);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(marker, index + marker.length);
  }
  return count;
}

export function countRailFirings(stdoutJsonl: string): Record<RuleName, number> {
  const counts = emptyRailFirings();

  for (const line of nonEmptyLines(stdoutJsonl)) {
    for (const text of toolResultTexts(line)) {
      for (const rule of RULE_NAMES) {
        counts[rule] += countRuleMarkersIn(text, `[${rule}]`);
      }
    }
  }

  return counts;
}

export function countShadowFirings(logContents: string): Record<RuleName, number> {
  const counts = emptyRailFirings();

  for (const line of nonEmptyLines(logContents)) {
    const parsed = parseJsonLine(line);
    if (typeof parsed !== "object" || parsed === null) continue;

    const rule = (parsed as Record<string, unknown>).rule;
    if (typeof rule === "string" && RULE_NAMES.includes(rule as RuleName)) {
      counts[rule as RuleName] += 1;
    }
  }

  return counts;
}

function silentCrashError(exitCode: number): string | undefined {
  return exitCode === 0 ? undefined : `agent exited ${exitCode} before any assistant response`;
}

function terminalAssistantError(lastAssistantEnd: AssistantEnd): string | undefined {
  if (lastAssistantEnd.stopReason !== "error") return undefined;
  return lastAssistantEnd.errorMessage ?? FALLBACK_AGENT_ERROR;
}

export function detectAgentError(stdoutJsonl: string, exitCode = 0): string | undefined {
  const lines = stdoutJsonl.split("\n").filter((line) => line.trim().length > 0);
  let lastAssistantEnd: AssistantEnd | undefined;

  for (const line of lines) {
    const retry = parseAutoRetryEnd(line);
    if (retry !== undefined && !retry.success) return retry.finalError ?? FALLBACK_AGENT_ERROR;
    lastAssistantEnd = parseAssistantMessageEnd(line) ?? lastAssistantEnd;
  }

  if (lastAssistantEnd === undefined) return silentCrashError(exitCode);
  return terminalAssistantError(lastAssistantEnd);
}

function rowKey(row: { caseId: string; conditionId: string; rep: number }): string {
  return `${row.caseId}\0${row.conditionId}\0${row.rep}`;
}

function itemKey(item: WorkItem): string {
  return rowKey({ caseId: item.kase.id, conditionId: item.condition.id, rep: item.rep });
}

function buildWorkItems(cases: CaseManifest[], conditions: ConditionManifest[], reps: number): WorkItem[] {
  const items: WorkItem[] = [];
  for (const kase of cases) {
    for (const condition of conditions) {
      for (let rep = 1; rep <= reps; rep += 1) {
        items.push({ kase, condition, rep });
      }
    }
  }
  return items;
}

export function loadExistingKeys(rawPath: string, keyOfRow: (row: RawRow) => string): Set<string> {
  if (!existsSync(rawPath)) return new Set();

  const lines = readFileSync(rawPath, "utf8").split("\n").filter((line) => line.length > 0);
  return new Set(lines.map((line) => keyOfRow(JSON.parse(line) as RawRow)));
}

export function packAbsolutePath(conditionsDir: string, condition: ConditionManifest): string | undefined {
  return condition.phrasingPack === undefined ? undefined : join(conditionsDir, condition.phrasingPack);
}

export function buildEnv(condition: ConditionManifest, packPath: string | undefined): Record<string, string> {
  const base = { ...condition.env, LIUBAI_EVAL: "1" };
  return packPath === undefined ? base : { ...base, LIUBAI_PHRASING_PACK: packPath };
}

export function copyCaseFiles(corpusDir: string, kase: CaseManifest, workDir: string): { from: string; to: string }[] {
  const caseDir = join(corpusDir, kase.id);
  const plan = copyPlan(caseDir, kase, workDir);
  for (const { from, to } of plan) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  return plan;
}

function readFinalFiles(workDir: string, plan: { to: string }[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const { to } of plan) {
    if (!existsSync(to)) continue;
    files[relative(workDir, to)] = readFileSync(to, "utf8");
  }
  return files;
}

export function snapshotWorkDir(workDir: string, plan: { to: string }[]): WorkDirSnapshot {
  const declared = new Set(plan.map(({ to }) => relative(workDir, to)));
  const extras = snapshotExtras(workDir, declared);
  return { files: { ...readFinalFiles(workDir, plan), ...extras.files }, dropped: extras.dropped };
}

function failureMessage(item: WorkItem, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `${item.kase.id}/${item.condition.id}/${item.rep}: ${reason}`;
}

export async function spawnForItem(
  ctx: CollectContext,
  task: string,
  workDir: string,
  env: Record<string, string>,
): Promise<{ outcome: RunOutcome; durationMs: number }> {
  const start = Date.now();
  const outcome = await ctx.spawner({
    cwd: workDir,
    env,
    model: ctx.model,
    task,
    timeoutMs: ctx.timeoutMs,
  });
  return { outcome, durationMs: Date.now() - start };
}

function readShadowFirings(workDir: string): Record<RuleName, number> | undefined {
  const shadowLogPath = join(workDir, ".liubai", "shadow.jsonl");
  if (!existsSync(shadowLogPath)) return undefined;
  return countShadowFirings(readFileSync(shadowLogPath, "utf8"));
}

export function buildRawRowCore(
  ctx: CollectContext,
  conditionId: string,
  packPath: string | undefined,
  outcome: RunOutcome,
  durationMs: number,
  snapshot: WorkDirSnapshot,
  shadowFirings?: Record<RuleName, number>,
): Omit<RawRow, "caseId" | "conditionId" | "rep"> {
  const packBytes = packPath === undefined ? null : readFileSync(packPath, "utf8");
  const provenance = buildProvenance({
    conditionId,
    packBytes,
    repoRoot: ctx.repoRoot,
    model: ctx.model,
    now: ctx.now(),
  });

  const agentError = detectAgentError(outcome.stdoutJsonl, outcome.exitCode);
  const tokenUsage = sumTokenUsage(outcome.stdoutJsonl);

  return {
    provenance,
    files: snapshot.files,
    ...(snapshot.dropped.length > 0 ? { snapshotDropped: snapshot.dropped } : {}),
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs,
    turns: countTurns(outcome.stdoutJsonl),
    tokensIn: tokenUsage.tokensIn,
    tokensOut: tokenUsage.tokensOut,
    cacheReadTokens: tokenUsage.cacheReadTokens,
    railFirings: countRailFirings(outcome.stdoutJsonl),
    ...(shadowFirings !== undefined ? { shadowFirings } : {}),
    ...(agentError !== undefined ? { agentError } : {}),
  };
}

function buildRawRow(
  ctx: CollectContext,
  item: WorkItem,
  packPath: string | undefined,
  outcome: RunOutcome,
  durationMs: number,
  snapshot: WorkDirSnapshot,
  shadowFirings: Record<RuleName, number> | undefined,
): RawRow {
  return {
    caseId: item.kase.id,
    conditionId: item.condition.id,
    rep: item.rep,
    ...buildRawRowCore(ctx, item.condition.id, packPath, outcome, durationMs, snapshot, shadowFirings),
  };
}

async function runItem(ctx: CollectContext, item: WorkItem): Promise<ItemResult> {
  const workDir = mkdtempSync(join(ctx.workRoot, "eval-work-"));
  const plan = copyCaseFiles(ctx.corpusDir, item.kase, workDir);
  const packPath = packAbsolutePath(ctx.conditionsDir, item.condition);
  const env = buildEnv(item.condition, packPath);

  try {
    const { outcome, durationMs } = await spawnForItem(ctx, item.kase.task, workDir, env);
    const snapshot = snapshotWorkDir(workDir, plan);
    const shadowFirings = readShadowFirings(workDir);
    const row = buildRawRow(ctx, item, packPath, outcome, durationMs, snapshot, shadowFirings);
    return { row, stdoutJsonl: outcome.stdoutJsonl };
  } catch (err) {
    return { failure: failureMessage(item, err) };
  }
}

function workItemTranscriptFilename(item: WorkItem): string {
  return `${item.kase.id}.${item.condition.id}.${item.rep}.jsonl`;
}

export function loadError(message: string): CollectResult {
  return { status: 1, rowsWritten: 0, rowsSkipped: 0, stderr: message };
}

function filterByTier(cases: CaseManifest[], tier: Tier | undefined): CaseManifest[] | { error: string } {
  if (tier === undefined) return cases;
  const filtered = cases.filter((kase) => kase.tier === tier);
  return filtered.length > 0 ? filtered : { error: `no cases with tier: ${tier}` };
}

export function validateParallel(parallel: number | undefined): CollectResult | undefined {
  if (parallel === undefined) return undefined;
  if (Number.isInteger(parallel) && parallel >= 1) return undefined;
  return loadError(`parallel must be a positive integer, got: ${parallel}`);
}

export interface EngineOptsBase {
  repoRoot: string;
  model: string;
  timeoutMs?: number;
  spawner?: PiSpawner;
  workRoot?: string;
  now?: () => string;
  parallel?: number;
}

export function buildContext(opts: EngineOptsBase, corpusDir: string, conditionsDir: string): CollectContext {
  return {
    repoRoot: opts.repoRoot,
    corpusDir,
    conditionsDir,
    model: opts.model,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    spawner: opts.spawner ?? defaultPiSpawner(opts.repoRoot),
    workRoot: opts.workRoot ?? tmpdir(),
    now: opts.now ?? (() => new Date().toISOString()),
    parallel: opts.parallel ?? 1,
  };
}

export interface CollectCounts {
  rowsWritten: number;
  rowsSkipped: number;
  failures: string[];
}

export interface EngineOps<T, C extends CollectContext = CollectContext> {
  keyOf: (item: T) => string;
  run: (ctx: C, item: T) => Promise<ItemResult>;
  transcriptFilename: (item: T) => string;
}

export function partitionItems<T>(
  items: T[],
  existingKeys: Set<string>,
  keyOf: (item: T) => string,
): { toRun: T[]; rowsSkipped: number } {
  const toRun: T[] = [];
  let rowsSkipped = 0;

  for (const item of items) {
    if (existingKeys.has(keyOf(item))) rowsSkipped += 1;
    else toRun.push(item);
  }

  return { toRun, rowsSkipped };
}

async function dispatchItem<T, C extends CollectContext>(
  ctx: C,
  runDir: string,
  rawPath: string,
  item: T,
  counts: CollectCounts,
  ops: EngineOps<T, C>,
): Promise<void> {
  const result = await ops.run(ctx, item);
  if (result.failure !== undefined) {
    counts.failures.push(result.failure);
    return;
  }

  appendFileSync(rawPath, `${JSON.stringify(result.row)}\n`);
  writeFileSync(join(runDir, "transcripts", ops.transcriptFilename(item)), result.stdoutJsonl ?? "");
  counts.rowsWritten += 1;
}

async function runLane<T, C extends CollectContext>(
  ctx: C,
  runDir: string,
  rawPath: string,
  items: T[],
  cursor: { next: number },
  counts: CollectCounts,
  ops: EngineOps<T, C>,
): Promise<void> {
  while (cursor.next < items.length) {
    const index = cursor.next;
    cursor.next += 1;
    const item = items[index];
    if (item === undefined) continue;
    await dispatchItem(ctx, runDir, rawPath, item, counts, ops);
  }
}

export async function runItemsConcurrently<T, C extends CollectContext = CollectContext>(
  ctx: C,
  runDir: string,
  rawPath: string,
  items: T[],
  existingKeys: Set<string>,
  ops: EngineOps<T, C>,
): Promise<CollectCounts> {
  const { toRun, rowsSkipped } = partitionItems(items, existingKeys, ops.keyOf);
  const counts: CollectCounts = { rowsWritten: 0, rowsSkipped, failures: [] };
  const cursor = { next: 0 };
  const laneCount = Math.min(ctx.parallel, toRun.length);
  const lanes = Array.from({ length: laneCount }, () => runLane(ctx, runDir, rawPath, toRun, cursor, counts, ops));

  await Promise.all(lanes);

  return counts;
}

const WORK_ITEM_OPS: EngineOps<WorkItem> = {
  keyOf: itemKey,
  run: runItem,
  transcriptFilename: workItemTranscriptFilename,
};

async function runWorkItems(
  ctx: CollectContext,
  runDir: string,
  rawPath: string,
  items: WorkItem[],
  existingKeys: Set<string>,
): Promise<CollectCounts> {
  return runItemsConcurrently(ctx, runDir, rawPath, items, existingKeys, WORK_ITEM_OPS);
}

export function toCollectResult(counts: CollectCounts): CollectResult {
  return {
    status: counts.failures.length > 0 ? 1 : 0,
    rowsWritten: counts.rowsWritten,
    rowsSkipped: counts.rowsSkipped,
    stderr: counts.failures.length > 0 ? `failures: ${counts.failures.join("; ")}` : "",
  };
}

export async function runCollect(opts: CollectOpts): Promise<CollectResult> {
  const parallelError = validateParallel(opts.parallel);
  if (parallelError !== undefined) return parallelError;

  const conditionsDir = opts.conditionsDir ?? join(import.meta.dirname, "conditions");
  const corpusDir = opts.corpusDir ?? join(import.meta.dirname, "corpus");

  const conditions = loadConditions(conditionsDir, opts.conditions);
  if ("error" in conditions) return loadError(conditions.error);

  const cases = loadCases(corpusDir, opts.cases);
  if ("error" in cases) return loadError(cases.error);

  const tieredCases = filterByTier(cases, opts.tier);
  if ("error" in tieredCases) return loadError(tieredCases.error);

  const rawPath = join(opts.runDir, "raw.jsonl");
  const existingKeys = loadExistingKeys(rawPath, rowKey);
  mkdirSync(join(opts.runDir, "transcripts"), { recursive: true });

  const ctx = buildContext(opts, corpusDir, conditionsDir);
  const items = buildWorkItems(tieredCases, conditions, opts.reps);
  const counts = await runWorkItems(ctx, opts.runDir, rawPath, items, existingKeys);

  return toCollectResult(counts);
}
