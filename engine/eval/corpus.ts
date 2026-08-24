import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Lang } from "../contract.ts";
import type { CaseManifest, BaselineMetrics } from "./eval-contract.ts";

type LoadResult = CaseManifest[] | { error: string };

const KNOWN_LANGS: readonly Lang[] = ["python", "typescript", "cpp"];

function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (KNOWN_LANGS as readonly string[]).includes(value);
}

function stripCaseSuffix(filename: string): string {
  return filename.slice(0, -".case".length);
}

function validateFiles(files: unknown): { value: string[] } | { error: string } {
  if (!Array.isArray(files) || files.length === 0 || files.some((f) => typeof f !== "string")) {
    return { error: "files must be a non-empty string array" };
  }
  const invalid = (files as string[]).find((f) => !f.endsWith(".case"));
  if (invalid !== undefined) return { error: `file does not end in .case: ${invalid}` };
  return { value: files as string[] };
}

function validateBaseline(baseline: unknown): { value: BaselineMetrics } | { error: string } {
  if (typeof baseline !== "object" || baseline === null) return { error: "baseline must be an object" };
  const { decisionPoints, functions, silentHandlers } = baseline as Record<string, unknown>;
  if (typeof decisionPoints !== "number") return { error: "baseline.decisionPoints must be a number" };
  if (typeof functions !== "number") return { error: "baseline.functions must be a number" };
  if (typeof silentHandlers !== "number") return { error: "baseline.silentHandlers must be a number" };
  return { value: { decisionPoints, functions, silentHandlers } };
}

function validateEntry(entry: unknown, files: string[]): { value: string } | { error: string } {
  if (typeof entry !== "string" || entry.length === 0) return { error: "entry must be a non-empty string" };
  const matches = files.some((f) => stripCaseSuffix(f) === entry);
  if (!matches) return { error: `entry matches no declared file: ${entry}` };
  return { value: entry };
}

function validateId(id: unknown): { value: string } | { error: string } {
  if (typeof id !== "string" || id.length === 0) return { error: "id must be a non-empty string" };
  return { value: id };
}

function validateLang(lang: unknown): { value: Lang } | { error: string } {
  if (!isLang(lang)) return { error: `unknown lang: ${String(lang)}` };
  return { value: lang };
}

function validateTask(task: unknown): { value: string } | { error: string } {
  if (typeof task !== "string" || task.length === 0) return { error: "task must be a non-empty string" };
  return { value: task };
}

interface ValidatedFields {
  id: string;
  lang: Lang;
  files: string[];
  entry: string;
  task: string;
  baseline: BaselineMetrics;
}

function validateFields(raw: Record<string, unknown>): { value: ValidatedFields } | { error: string } {
  const id = validateId(raw.id);
  if ("error" in id) return id;

  const lang = validateLang(raw.lang);
  if ("error" in lang) return lang;

  const files = validateFiles(raw.files);
  if ("error" in files) return files;

  const entry = validateEntry(raw.entry, files.value);
  if ("error" in entry) return entry;

  const task = validateTask(raw.task);
  if ("error" in task) return task;

  const baseline = validateBaseline(raw.baseline);
  if ("error" in baseline) return baseline;

  return {
    value: {
      id: id.value,
      lang: lang.value,
      files: files.value,
      entry: entry.value,
      task: task.value,
      baseline: baseline.value,
    },
  };
}

function validateManifestShape(raw: unknown): { manifest: CaseManifest } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "case manifest must be a JSON object" };

  const fields = validateFields(raw as Record<string, unknown>);
  if ("error" in fields) return fields;

  return { manifest: fields.value };
}

function ensureFilesExist(caseDir: string, files: string[]): { error: string } | undefined {
  const missing = files.find((f) => !existsSync(join(caseDir, f)));
  if (missing !== undefined) return { error: `declared file missing on disk: ${missing}` };
  return undefined;
}

function loadCase(caseDir: string, id: string): { manifest: CaseManifest } | { error: string } {
  const raw: unknown = JSON.parse(readFileSync(join(caseDir, "manifest.json"), "utf8"));
  const validated = validateManifestShape(raw);
  if ("error" in validated) return { error: `${id}: ${validated.error}` };

  const missingError = ensureFilesExist(caseDir, validated.manifest.files);
  if (missingError !== undefined) return { error: `${id}: ${missingError.error}` };

  return validated;
}

function subdirectories(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function readAllCases(corpusDir: string): LoadResult {
  const cases: CaseManifest[] = [];
  for (const id of subdirectories(corpusDir)) {
    const result = loadCase(join(corpusDir, id), id);
    if ("error" in result) return result;
    cases.push(result.manifest);
  }
  return cases;
}

function filterByOnly(cases: CaseManifest[], only: string[]): LoadResult {
  const byId = new Map(cases.map((c) => [c.id, c]));

  const filtered: CaseManifest[] = [];
  for (const id of only) {
    const kase = byId.get(id);
    if (kase === undefined) return { error: `unknown case id in filter: ${id}` };
    filtered.push(kase);
  }
  return filtered;
}

export function loadCases(corpusDir: string, only?: string[]): LoadResult {
  const cases = readAllCases(corpusDir);
  if ("error" in cases) return cases;

  if (only === undefined) return cases;
  return filterByOnly(cases, only);
}

export function copyPlan(caseDir: string, kase: CaseManifest, workDir: string): { from: string; to: string }[] {
  return kase.files.map((file) => ({
    from: join(caseDir, file),
    to: join(workDir, stripCaseSuffix(file)),
  }));
}
