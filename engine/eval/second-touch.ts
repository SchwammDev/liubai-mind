import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { CaseManifest, TreatmentManifest, RawRow } from "./eval-contract.ts";
import { loadTreatments } from "./treatments.ts";
import { loadCases } from "./corpus.ts";
import type { PiSpawner, RunOutcome } from "./spawner.ts";
import type { WorkDirSnapshot } from "./snapshot.ts";
import {
  buildContext,
  buildEnv,
  buildRawRowCore,
  copyCaseFiles,
  loadError,
  loadExistingKeys,
  packAbsolutePath,
  readDelivered,
  readPackContent,
  runItemsConcurrently,
  snapshotWorkDir,
  spawnForItem,
  validateParallel,
} from "./collect.ts";
import type { CollectContext, EngineOps, ItemResult } from "./collect.ts";

export interface SecondTouchOpts {
  repoRoot: string;
  runDir: string;
  sourceRunDir: string;
  sourceRun: string;
  model: string;
  timeoutMs?: number;
  cases?: string[];
  treatments?: string[];
  spawner?: PiSpawner;
  workRoot?: string;
  now?: () => string;
  treatmentsDir?: string;
  corpusDir?: string;
  parallel?: number;
}

export interface SecondTouchResult {
  status: number;
  rowsWritten: number;
  rowsSkipped: number;
  stderr: string;
}

interface SecondTouchContext extends CollectContext {
  sourceRun: string;
}

interface SecondTouchItem {
  kase: CaseManifest;
  treatment: TreatmentManifest;
  control: boolean;
  sourceRepetition: number | null;
  sourceFiles?: Record<string, string>;
}

interface LoadedInputs {
  casesWithExtension: Map<string, CaseManifest>;
  treatmentsById: Map<string, TreatmentManifest>;
  sourceRows: RawRow[];
}

function readSourceRows(sourceRunDir: string): RawRow[] | { error: string } {
  const rawPath = join(sourceRunDir, "raw.jsonl");
  let raw: string;
  try {
    raw = readFileSync(rawPath, "utf8");
  } catch {
    return { error: `source run raw.jsonl not found: ${rawPath}` };
  }
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RawRow);
}

function extensionCasesById(cases: CaseManifest[]): Map<string, CaseManifest> {
  const byId = new Map<string, CaseManifest>();
  for (const kase of cases) {
    if (kase.extension !== undefined) byId.set(kase.id, kase);
  }
  return byId;
}

function loadInputs(opts: SecondTouchOpts, corpusDir: string, treatmentsDir: string): LoadedInputs | { error: string } {
  const cases = loadCases(corpusDir, opts.cases);
  if ("error" in cases) return cases;

  const casesWithExtension = extensionCasesById(cases);
  if (casesWithExtension.size === 0) return { error: "no case in the filter has an extension.json" };

  const treatmentsResult = loadTreatments(treatmentsDir, opts.treatments);
  if ("error" in treatmentsResult) return treatmentsResult;

  const sourceRows = readSourceRows(opts.sourceRunDir);
  if ("error" in sourceRows) return sourceRows;

  return { casesWithExtension, treatmentsById: new Map(treatmentsResult.map((c) => [c.id, c])), sourceRows };
}

function modelMismatchWarning(sourceRows: RawRow[], model: string): string | undefined {
  const sourceModel = sourceRows[0]?.provenance.model;
  if (sourceModel === undefined || sourceModel === model) return undefined;
  return `--model ${model} differs from the source run's provenance model ${sourceModel}; second-touch design assumes the same model returns for the next feature`;
}

function relevantSourceRows(inputs: LoadedInputs): RawRow[] {
  return inputs.sourceRows.filter((row) => inputs.casesWithExtension.has(row.caseId) && inputs.treatmentsById.has(row.treatmentId));
}

function seedEntryContentCache(corpusDir: string): (kase: CaseManifest) => string {
  const cache = new Map<string, string>();
  return (kase: CaseManifest) => {
    const cached = cache.get(kase.id);
    if (cached !== undefined) return cached;
    const content = readFileSync(join(corpusDir, kase.id, `${kase.entry}.case`), "utf8");
    cache.set(kase.id, content);
    return content;
  };
}

function isUntouchedRow(row: RawRow, kase: CaseManifest, seedEntryContent: (kase: CaseManifest) => string): boolean {
  return row.files[kase.entry] === seedEntryContent(kase);
}

function buildSeededItems(rows: RawRow[], inputs: LoadedInputs, seedEntryContent: (kase: CaseManifest) => string): SecondTouchItem[] {
  const items: SecondTouchItem[] = [];
  for (const row of rows) {
    if (row.agentError !== undefined) continue;
    if (row.timedOut) continue;
    const kase = inputs.casesWithExtension.get(row.caseId)!;
    if (row.files[kase.entry] === undefined) continue;
    if (isUntouchedRow(row, kase, seedEntryContent)) continue;

    items.push({
      kase,
      treatment: inputs.treatmentsById.get(row.treatmentId)!,
      control: false,
      sourceRepetition: row.repetition,
      sourceFiles: row.files,
    });
  }
  return items;
}

function treatmentIdsForCase(rows: RawRow[], caseId: string): Set<string> {
  return new Set(rows.filter((r) => r.caseId === caseId).map((r) => r.treatmentId));
}

function buildControlItems(rows: RawRow[], inputs: LoadedInputs): SecondTouchItem[] {
  const items: SecondTouchItem[] = [];
  for (const kase of inputs.casesWithExtension.values()) {
    for (const treatmentId of treatmentIdsForCase(rows, kase.id)) {
      items.push({ kase, treatment: inputs.treatmentsById.get(treatmentId)!, control: true, sourceRepetition: null });
    }
  }
  return items;
}

function buildSecondTouchItems(inputs: LoadedInputs, corpusDir: string): SecondTouchItem[] {
  const relevantRows = relevantSourceRows(inputs);
  const seedEntryContent = seedEntryContentCache(corpusDir);
  return [...buildSeededItems(relevantRows, inputs, seedEntryContent), ...buildControlItems(relevantRows, inputs)];
}

function keyParts(caseId: string, treatmentId: string, control: boolean, sourceRepetition: number | null): string {
  return `${caseId}\0${treatmentId}\0${control ? "control" : `seed:${sourceRepetition}`}`;
}

function secondTouchItemKey(item: SecondTouchItem): string {
  return keyParts(item.kase.id, item.treatment.id, item.control, item.sourceRepetition);
}

function secondTouchRowKey(row: RawRow): string {
  const st = row.secondTouch;
  return keyParts(row.caseId, row.treatmentId, st?.control ?? false, st?.sourceRepetition ?? null);
}

function secondTouchTranscriptFilename(item: SecondTouchItem): string {
  const suffix = item.control ? "control" : `seed-${item.sourceRepetition}`;
  return `${item.kase.id}.${item.treatment.id}.${suffix}.jsonl`;
}

function materializeSourceFiles(workDir: string, files: Record<string, string>): { to: string }[] {
  const plan: { to: string }[] = [];
  for (const [relPath, content] of Object.entries(files)) {
    const to = join(workDir, relPath);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, content);
    plan.push({ to });
  }
  return plan;
}

function buildSecondTouchRow(
  ctx: SecondTouchContext,
  item: SecondTouchItem,
  packContent: string | undefined,
  outcome: RunOutcome,
  durationMs: number,
  snapshot: WorkDirSnapshot,
  delivered: RawRow["delivered"],
): RawRow {
  const core = buildRawRowCore(ctx, item.treatment.id, packContent, outcome, durationMs, snapshot, undefined, delivered);
  return {
    caseId: item.kase.id,
    treatmentId: item.treatment.id,
    repetition: item.control ? 1 : item.sourceRepetition!,
    ...core,
    secondTouch: { sourceRun: ctx.sourceRun, sourceRepetition: item.control ? null : item.sourceRepetition, control: item.control },
  };
}

function secondTouchFailureMessage(item: SecondTouchItem, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  const label = item.control ? "control" : `seed:${item.sourceRepetition}`;
  return `${item.kase.id}/${item.treatment.id}/${label}: ${reason}`;
}

function workDirPlanFor(ctx: SecondTouchContext, item: SecondTouchItem, workDir: string): { to: string }[] {
  return item.control ? copyCaseFiles(ctx.corpusDir, item.kase, workDir) : materializeSourceFiles(workDir, item.sourceFiles!);
}

async function runSecondTouchItem(ctx: SecondTouchContext, item: SecondTouchItem): Promise<ItemResult> {
  const workDir = mkdtempSync(join(ctx.workRoot, "eval-work-"));
  const plan = workDirPlanFor(ctx, item, workDir);
  const packPath = packAbsolutePath(ctx.treatmentsDir, item.treatment);
  const packContent = readPackContent(packPath);
  const env = buildEnv(item.treatment, packContent);

  try {
    const { outcome, durationMs } = await spawnForItem(ctx, item.kase.extension!.task, workDir, env);
    const snapshot = snapshotWorkDir(workDir, plan);
    const delivered = readDelivered(workDir);
    const row = buildSecondTouchRow(ctx, item, packContent, outcome, durationMs, snapshot, delivered);
    return { row, stdoutJsonl: outcome.stdoutJsonl };
  } catch (err) {
    return { failure: secondTouchFailureMessage(item, err) };
  }
}

const SECOND_TOUCH_OPS: EngineOps<SecondTouchItem, SecondTouchContext> = {
  keyOf: secondTouchItemKey,
  run: runSecondTouchItem,
  transcriptFilename: secondTouchTranscriptFilename,
};

function toSecondTouchResult(
  counts: { rowsWritten: number; rowsSkipped: number; failures: string[] },
  warnings: string[],
): SecondTouchResult {
  const failureLine = counts.failures.length > 0 ? `failures: ${counts.failures.join("; ")}` : "";
  return {
    status: counts.failures.length > 0 ? 1 : 0,
    rowsWritten: counts.rowsWritten,
    rowsSkipped: counts.rowsSkipped,
    stderr: [...warnings, failureLine].filter((s) => s.length > 0).join("\n"),
  };
}

export async function runSecondTouch(opts: SecondTouchOpts): Promise<SecondTouchResult> {
  const parallelError = validateParallel(opts.parallel);
  if (parallelError !== undefined) return parallelError;
  if (resolve(opts.runDir) === resolve(opts.sourceRunDir)) {
    return loadError("second-touch must write into a new run, not the source run");
  }

  const treatmentsDir = opts.treatmentsDir ?? join(import.meta.dirname, "treatments");
  const corpusDir = opts.corpusDir ?? join(import.meta.dirname, "corpus");

  const inputs = loadInputs(opts, corpusDir, treatmentsDir);
  if ("error" in inputs) return loadError(inputs.error);

  const mismatch = modelMismatchWarning(inputs.sourceRows, opts.model);
  const warnings = mismatch === undefined ? [] : [mismatch];
  const items = buildSecondTouchItems(inputs, corpusDir);

  const rawPath = join(opts.runDir, "raw.jsonl");
  const existingKeys = loadExistingKeys(rawPath, secondTouchRowKey);
  mkdirSync(join(opts.runDir, "transcripts"), { recursive: true });

  const ctx: SecondTouchContext = { ...buildContext(opts, corpusDir, treatmentsDir), sourceRun: opts.sourceRun };
  const counts = await runItemsConcurrently(ctx, opts.runDir, rawPath, items, existingKeys, SECOND_TOUCH_OPS);

  return toSecondTouchResult(counts, warnings);
}
