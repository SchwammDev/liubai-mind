import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Lang } from "../contract.ts";
import type { CaseManifest, BaselineMetrics, ExtensionSpec, Probe, Tier } from "./eval-contract.ts";

type LoadResult = CaseManifest[] | { error: string };

const KNOWN_LANGS: readonly Lang[] = ["python", "typescript", "cpp"];
const KNOWN_TIERS: readonly Tier[] = ["easy", "hard"];
const KNOWN_MANIFEST_KEYS = [
  "id",
  "lang",
  "files",
  "entry",
  "entrySymbol",
  "task",
  "baseline",
  "tier",
  "tags",
  "genuineDpMax",
] as const;

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (KNOWN_TIERS as readonly string[]).includes(value);
}

function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (KNOWN_LANGS as readonly string[]).includes(value);
}

function stripCaseSuffix(filename: string): string {
  return filename.slice(0, -".case".length);
}

export function declaredFiles(kase: CaseManifest): string[] {
  return kase.files.map(stripCaseSuffix);
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

interface FileFields {
  files: string[];
  entry: string;
}

function validateFilesAndEntry(raw: Record<string, unknown>): { value: FileFields } | { error: string } {
  const files = validateFiles(raw.files);
  if ("error" in files) return files;

  const entry = validateEntry(raw.entry, files.value);
  if ("error" in entry) return entry;

  return { value: { files: files.value, entry: entry.value } };
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

function validateEntrySymbol(entrySymbol: unknown): { value: string } | { error: string } {
  if (typeof entrySymbol !== "string" || entrySymbol.length === 0) {
    return { error: "entrySymbol must be a non-empty string" };
  }
  return { value: entrySymbol };
}

function validateTier(tier: unknown): { value: Tier } | { error: string } {
  if (!isTier(tier)) return { error: `tier must be "easy" or "hard", got: ${String(tier)}` };
  return { value: tier };
}

function validateTags(tags: unknown): { value: string[] | undefined } | { error: string } {
  if (tags === undefined) return { value: undefined };
  if (!Array.isArray(tags) || tags.length === 0 || tags.some((t) => typeof t !== "string" || t.length === 0)) {
    return { error: "tags must be a non-empty array of non-empty strings" };
  }
  return { value: tags as string[] };
}

function validateGenuineDpMax(
  genuineDpMax: unknown,
  tier: Tier,
  baselineDecisionPoints: number,
): { value: number | undefined } | { error: string } {
  if (genuineDpMax === undefined) {
    if (tier === "hard") return { error: "genuineDpMax is required when tier is \"hard\"" };
    return { value: undefined };
  }
  const isValid = typeof genuineDpMax === "number" && Number.isInteger(genuineDpMax) && genuineDpMax >= 0 && genuineDpMax < baselineDecisionPoints;
  if (!isValid) {
    return { error: "genuineDpMax must be an integer with 0 <= genuineDpMax < baseline.decisionPoints" };
  }
  return { value: genuineDpMax };
}

function unknownManifestKeys(raw: Record<string, unknown>): string[] {
  return Object.keys(raw).filter((key) => !(KNOWN_MANIFEST_KEYS as readonly string[]).includes(key));
}

interface TierFields {
  tier: Tier;
  tags?: string[];
  genuineDpMax?: number;
}

function validateTierFields(raw: Record<string, unknown>, baselineDecisionPoints: number): { value: TierFields } | { error: string } {
  const tier = validateTier(raw.tier);
  if ("error" in tier) return tier;

  const tags = validateTags(raw.tags);
  if ("error" in tags) return tags;

  const genuineDpMax = validateGenuineDpMax(raw.genuineDpMax, tier.value, baselineDecisionPoints);
  if ("error" in genuineDpMax) return genuineDpMax;

  return {
    value: {
      tier: tier.value,
      ...(tags.value !== undefined ? { tags: tags.value } : {}),
      ...(genuineDpMax.value !== undefined ? { genuineDpMax: genuineDpMax.value } : {}),
    },
  };
}

interface ValidatedFields {
  id: string;
  lang: Lang;
  files: string[];
  entry: string;
  entrySymbol: string;
  task: string;
  baseline: BaselineMetrics;
  tier: Tier;
  tags?: string[];
  genuineDpMax?: number;
}

function validateFields(raw: Record<string, unknown>): { value: ValidatedFields } | { error: string } {
  const id = validateId(raw.id);
  if ("error" in id) return id;

  const lang = validateLang(raw.lang);
  if ("error" in lang) return lang;

  const fileFields = validateFilesAndEntry(raw);
  if ("error" in fileFields) return fileFields;

  const entrySymbol = validateEntrySymbol(raw.entrySymbol);
  if ("error" in entrySymbol) return entrySymbol;

  const task = validateTask(raw.task);
  if ("error" in task) return task;

  const baseline = validateBaseline(raw.baseline);
  if ("error" in baseline) return baseline;

  const tierFields = validateTierFields(raw, baseline.value.decisionPoints);
  if ("error" in tierFields) return tierFields;

  return {
    value: {
      id: id.value,
      lang: lang.value,
      files: fileFields.value.files,
      entry: fileFields.value.entry,
      entrySymbol: entrySymbol.value,
      task: task.value,
      baseline: baseline.value,
      ...tierFields.value,
    },
  };
}

function validateManifestShape(raw: unknown): { fields: ValidatedFields } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "case manifest must be a JSON object" };

  const fields = validateFields(raw as Record<string, unknown>);
  if ("error" in fields) return fields;

  const unknownKeys = unknownManifestKeys(raw as Record<string, unknown>);
  if (unknownKeys.length > 0) return { error: `unknown top-level key(s): ${unknownKeys.join(", ")}` };

  return { fields: fields.value };
}

function validateProbe(raw: unknown, index: number): { value: Probe } | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: `probe ${index}: must be an object` };

  const { args, returns, throws } = raw as Record<string, unknown>;
  if (!Array.isArray(args)) return { error: `probe ${index}: args must be an array` };

  const hasReturns = "returns" in raw;
  const hasThrows = "throws" in raw;
  if (hasReturns === hasThrows) return { error: `probe ${index}: exactly one of returns or throws required` };

  if (hasThrows) {
    if (typeof throws !== "string") return { error: `probe ${index}: throws must be a string` };
    return { value: { args, throws } };
  }

  return { value: { args, returns } };
}

function validateProbes(raw: unknown): { value: Probe[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "probes must be a non-empty array" };

  const probes: Probe[] = [];
  for (let i = 0; i < raw.length; i++) {
    const probe = validateProbe(raw[i], i + 1);
    if ("error" in probe) return probe;
    probes.push(probe.value);
  }
  return { value: probes };
}

function loadProbes(caseDir: string): { value: Probe[] } | { error: string } {
  const probesPath = join(caseDir, "probes.json");
  if (!existsSync(probesPath)) return { error: "probes.json is missing" };

  const raw: unknown = JSON.parse(readFileSync(probesPath, "utf8"));
  return validateProbes(raw);
}

const EXTENSION_FILENAME = "extension.json";

function loadExtension(caseDir: string): { value: ExtensionSpec | undefined } | { error: string } {
  const extensionPath = join(caseDir, EXTENSION_FILENAME);
  if (!existsSync(extensionPath)) return { value: undefined };

  const raw: unknown = JSON.parse(readFileSync(extensionPath, "utf8"));
  if (typeof raw !== "object" || raw === null) return { error: `${EXTENSION_FILENAME}: must be a JSON object` };

  const { task, probes } = raw as Record<string, unknown>;

  const taskResult = validateTask(task);
  if ("error" in taskResult) return { error: `${EXTENSION_FILENAME}: ${taskResult.error}` };

  const probesResult = validateProbes(probes);
  if ("error" in probesResult) return { error: `${EXTENSION_FILENAME}: ${probesResult.error}` };

  return { value: { task: taskResult.value, probes: probesResult.value } };
}

function ensureFilesExist(caseDir: string, files: string[]): { error: string } | undefined {
  const missing = files.find((f) => !existsSync(join(caseDir, f)));
  if (missing !== undefined) return { error: `declared file missing on disk: ${missing}` };
  return undefined;
}

const REFERENCE_DIRNAME = "reference";

function referenceDirOf(caseDir: string): string {
  return join(caseDir, REFERENCE_DIRNAME);
}

function invalidReferenceFilename(filenames: string[]): string | undefined {
  return filenames.find((f) => !f.endsWith(".case"));
}

function readReferenceFiles(referenceDir: string, filenames: string[]): Record<string, string> {
  const reference: Record<string, string> = {};
  for (const filename of filenames) {
    reference[stripCaseSuffix(filename)] = readFileSync(join(referenceDir, filename), "utf8");
  }
  return reference;
}

function loadReference(caseDir: string, entry: string, tier: Tier): { value: Record<string, string> | undefined } | { error: string } {
  const referenceDir = referenceDirOf(caseDir);
  if (!existsSync(referenceDir)) {
    if (tier === "hard") return { error: `hard case requires a ${REFERENCE_DIRNAME}/ directory` };
    return { value: undefined };
  }

  const filenames = readdirSync(referenceDir);
  const invalid = invalidReferenceFilename(filenames);
  if (invalid !== undefined) return { error: `${REFERENCE_DIRNAME} file does not end in .case: ${invalid}` };

  const entryFile = `${entry}.case`;
  if (!filenames.includes(entryFile)) return { error: `${REFERENCE_DIRNAME}/ is missing the entry file: ${entryFile}` };

  return { value: readReferenceFiles(referenceDir, filenames) };
}

function loadCase(caseDir: string, id: string): { manifest: CaseManifest } | { error: string } {
  const raw: unknown = JSON.parse(readFileSync(join(caseDir, "manifest.json"), "utf8"));
  const validated = validateManifestShape(raw);
  if ("error" in validated) return { error: `${id}: ${validated.error}` };

  const missingError = ensureFilesExist(caseDir, validated.fields.files);
  if (missingError !== undefined) return { error: `${id}: ${missingError.error}` };

  const probes = loadProbes(caseDir);
  if ("error" in probes) return { error: `${id}: ${probes.error}` };

  const reference = loadReference(caseDir, validated.fields.entry, validated.fields.tier);
  if ("error" in reference) return { error: `${id}: ${reference.error}` };

  const extension = loadExtension(caseDir);
  if ("error" in extension) return { error: `${id}: ${extension.error}` };

  return {
    manifest: {
      ...validated.fields,
      probes: probes.value,
      ...(reference.value !== undefined ? { reference: reference.value } : {}),
      ...(extension.value !== undefined ? { extension: extension.value } : {}),
    },
  };
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
