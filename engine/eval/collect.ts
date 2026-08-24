import { mkdirSync, mkdtempSync, existsSync, readFileSync, appendFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { CaseManifest, ConditionManifest, RawRow } from "./eval-contract.ts";
import { loadConditions } from "./conditions.ts";
import { loadCases, copyPlan } from "./corpus.ts";
import { buildProvenance } from "./provenance.ts";
import { defaultPiSpawner } from "./spawner.ts";
import type { PiSpawner, RunOutcome } from "./spawner.ts";

export interface CollectOpts {
  repoRoot: string;
  runDir: string;
  reps: number;
  model: string;
  timeoutMs?: number;
  cases?: string[];
  conditions?: string[];
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

interface CollectContext {
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

interface ItemResult {
  row?: RawRow;
  stdoutJsonl?: string;
  failure?: string;
}

const DEFAULT_TIMEOUT_MS = 300000;
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

export function detectAgentError(stdoutJsonl: string): string | undefined {
  const lines = stdoutJsonl.split("\n").filter((line) => line.trim().length > 0);
  let lastAssistantEnd: AssistantEnd | undefined;

  for (const line of lines) {
    const retry = parseAutoRetryEnd(line);
    if (retry !== undefined && !retry.success) return retry.finalError ?? FALLBACK_AGENT_ERROR;
    lastAssistantEnd = parseAssistantMessageEnd(line) ?? lastAssistantEnd;
  }

  if (lastAssistantEnd?.stopReason !== "error") return undefined;
  return lastAssistantEnd.errorMessage ?? FALLBACK_AGENT_ERROR;
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

function loadExistingKeys(rawPath: string): Set<string> {
  if (!existsSync(rawPath)) return new Set();

  const lines = readFileSync(rawPath, "utf8").split("\n").filter((line) => line.length > 0);
  return new Set(lines.map((line) => rowKey(JSON.parse(line) as RawRow)));
}

function packAbsolutePath(conditionsDir: string, condition: ConditionManifest): string | undefined {
  return condition.phrasingPack === undefined ? undefined : join(conditionsDir, condition.phrasingPack);
}

function buildEnv(condition: ConditionManifest, packPath: string | undefined): Record<string, string> {
  return packPath === undefined ? { ...condition.env } : { ...condition.env, LIUBAI_PHRASING_PACK: packPath };
}

function copyCaseFiles(corpusDir: string, kase: CaseManifest, workDir: string): { from: string; to: string }[] {
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

function failureMessage(item: WorkItem, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return `${item.kase.id}/${item.condition.id}/${item.rep}: ${reason}`;
}

async function spawnForItem(
  ctx: CollectContext,
  item: WorkItem,
  workDir: string,
  env: Record<string, string>,
): Promise<{ outcome: RunOutcome; durationMs: number }> {
  const start = Date.now();
  const outcome = await ctx.spawner({
    cwd: workDir,
    env,
    model: ctx.model,
    task: item.kase.task,
    timeoutMs: ctx.timeoutMs,
  });
  return { outcome, durationMs: Date.now() - start };
}

function buildRawRow(
  ctx: CollectContext,
  item: WorkItem,
  packPath: string | undefined,
  outcome: RunOutcome,
  durationMs: number,
  files: Record<string, string>,
): RawRow {
  const packBytes = packPath === undefined ? null : readFileSync(packPath, "utf8");
  const provenance = buildProvenance({
    conditionId: item.condition.id,
    packBytes,
    repoRoot: ctx.repoRoot,
    model: ctx.model,
    now: ctx.now(),
  });

  const agentError = detectAgentError(outcome.stdoutJsonl);

  return {
    caseId: item.kase.id,
    conditionId: item.condition.id,
    rep: item.rep,
    provenance,
    files,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs,
    ...(agentError !== undefined ? { agentError } : {}),
  };
}

async function runItem(ctx: CollectContext, item: WorkItem): Promise<ItemResult> {
  const workDir = mkdtempSync(join(ctx.workRoot, "eval-work-"));
  const plan = copyCaseFiles(ctx.corpusDir, item.kase, workDir);
  const packPath = packAbsolutePath(ctx.conditionsDir, item.condition);
  const env = buildEnv(item.condition, packPath);

  try {
    const { outcome, durationMs } = await spawnForItem(ctx, item, workDir, env);
    const files = readFinalFiles(workDir, plan);
    const row = buildRawRow(ctx, item, packPath, outcome, durationMs, files);
    return { row, stdoutJsonl: outcome.stdoutJsonl };
  } catch (err) {
    return { failure: failureMessage(item, err) };
  }
}

function transcriptPath(runDir: string, item: WorkItem): string {
  return join(runDir, "transcripts", `${item.kase.id}.${item.condition.id}.${item.rep}.jsonl`);
}

function loadError(message: string): CollectResult {
  return { status: 1, rowsWritten: 0, rowsSkipped: 0, stderr: message };
}

function validateParallel(parallel: number | undefined): CollectResult | undefined {
  if (parallel === undefined) return undefined;
  if (Number.isInteger(parallel) && parallel >= 1) return undefined;
  return loadError(`parallel must be a positive integer, got: ${parallel}`);
}

function buildContext(opts: CollectOpts, corpusDir: string, conditionsDir: string): CollectContext {
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

interface CollectCounts {
  rowsWritten: number;
  rowsSkipped: number;
  failures: string[];
}

function partitionItems(items: WorkItem[], existingKeys: Set<string>): { toRun: WorkItem[]; rowsSkipped: number } {
  const toRun: WorkItem[] = [];
  let rowsSkipped = 0;

  for (const item of items) {
    if (existingKeys.has(itemKey(item))) rowsSkipped += 1;
    else toRun.push(item);
  }

  return { toRun, rowsSkipped };
}

async function dispatchItem(
  ctx: CollectContext,
  runDir: string,
  rawPath: string,
  item: WorkItem,
  counts: CollectCounts,
): Promise<void> {
  const result = await runItem(ctx, item);
  if (result.failure !== undefined) {
    counts.failures.push(result.failure);
    return;
  }

  appendFileSync(rawPath, `${JSON.stringify(result.row)}\n`);
  writeFileSync(transcriptPath(runDir, item), result.stdoutJsonl ?? "");
  counts.rowsWritten += 1;
}

async function runLane(
  ctx: CollectContext,
  runDir: string,
  rawPath: string,
  items: WorkItem[],
  cursor: { next: number },
  counts: CollectCounts,
): Promise<void> {
  while (cursor.next < items.length) {
    const index = cursor.next;
    cursor.next += 1;
    const item = items[index];
    if (item === undefined) continue;
    await dispatchItem(ctx, runDir, rawPath, item, counts);
  }
}

async function runWorkItems(
  ctx: CollectContext,
  runDir: string,
  rawPath: string,
  items: WorkItem[],
  existingKeys: Set<string>,
): Promise<CollectCounts> {
  const { toRun, rowsSkipped } = partitionItems(items, existingKeys);
  const counts: CollectCounts = { rowsWritten: 0, rowsSkipped, failures: [] };
  const cursor = { next: 0 };
  const laneCount = Math.min(ctx.parallel, toRun.length);
  const lanes = Array.from({ length: laneCount }, () => runLane(ctx, runDir, rawPath, toRun, cursor, counts));

  await Promise.all(lanes);

  return counts;
}

function toCollectResult(counts: CollectCounts): CollectResult {
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

  const rawPath = join(opts.runDir, "raw.jsonl");
  const existingKeys = loadExistingKeys(rawPath);
  mkdirSync(join(opts.runDir, "transcripts"), { recursive: true });

  const ctx = buildContext(opts, corpusDir, conditionsDir);
  const items = buildWorkItems(cases, conditions, opts.reps);
  const counts = await runWorkItems(ctx, opts.runDir, rawPath, items, existingKeys);

  return toCollectResult(counts);
}
