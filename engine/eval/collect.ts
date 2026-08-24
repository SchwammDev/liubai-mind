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
}

interface ItemResult {
  row?: RawRow;
  stdoutJsonl?: string;
  failure?: string;
}

const DEFAULT_TIMEOUT_MS = 300000;

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

  return {
    caseId: item.kase.id,
    conditionId: item.condition.id,
    rep: item.rep,
    provenance,
    files,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs,
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
  };
}

interface CollectCounts {
  rowsWritten: number;
  rowsSkipped: number;
  failures: string[];
}

async function runWorkItems(
  ctx: CollectContext,
  runDir: string,
  rawPath: string,
  items: WorkItem[],
  existingKeys: Set<string>,
): Promise<CollectCounts> {
  let rowsWritten = 0;
  let rowsSkipped = 0;
  const failures: string[] = [];

  for (const item of items) {
    if (existingKeys.has(itemKey(item))) {
      rowsSkipped += 1;
      continue;
    }

    const result = await runItem(ctx, item);
    if (result.failure !== undefined) {
      failures.push(result.failure);
      continue;
    }

    appendFileSync(rawPath, `${JSON.stringify(result.row)}\n`);
    writeFileSync(transcriptPath(runDir, item), result.stdoutJsonl ?? "");
    rowsWritten += 1;
  }

  return { rowsWritten, rowsSkipped, failures };
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
