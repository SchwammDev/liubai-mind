import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { TreatmentManifest } from "./eval-contract.ts";
import { validateNudgePhrasing } from "./phrasing.ts";

type LoadResult = TreatmentManifest[] | { error: string };

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function validateId(id: unknown): { value: string } | { error: string } {
  if (typeof id !== "string" || id.length === 0) return { error: "treatment id must be a non-empty string" };
  return { value: id };
}

function validateEnv(env: unknown): { value: Record<string, string> } | { error: string } {
  if (!isStringRecord(env)) return { error: "treatment env must be an object of string values" };
  return { value: env };
}

function validateOptionalString(value: unknown, label: string): { value: string | undefined } | { error: string } {
  if (value === undefined) return { value: undefined };
  if (typeof value !== "string") return { error: `treatment ${label} must be a string` };
  return { value };
}

function validateOptionalBoolean(value: unknown, label: string): { value: boolean | undefined } | { error: string } {
  if (value === undefined) return { value: undefined };
  if (typeof value !== "boolean") return { error: `treatment ${label} must be a boolean` };
  return { value };
}

function validateDelivery(value: unknown): { value: "prompt" | "rail" | undefined } | { error: string } {
  if (value === undefined) return { value: undefined };
  if (value === "prompt" || value === "rail") return { value };
  return { error: `treatment delivery must be "prompt" or "rail", got: ${JSON.stringify(value)}` };
}

function validateDeliveryClosesLiveRail(
  delivery: "prompt" | "rail" | undefined,
  env: Record<string, string>,
  id: string,
): { error: string } | undefined {
  if (delivery !== "prompt") return undefined;
  if (env.LIUBAI_RAILS_OFF !== undefined) return undefined;
  return {
    error: `treatment ${id}: delivery: "prompt" requires env.LIUBAI_RAILS_OFF — a prompt-carried treatment must close the live rail so the prompt is the only treatment channel`,
  };
}

function validateDeliveryPinsNudgePhrasingFile(
  delivery: "prompt" | "rail" | undefined,
  nudgePhrasingFile: string | undefined,
  id: string,
): { error: string } | undefined {
  if (delivery !== "prompt") return undefined;
  if (nudgePhrasingFile !== undefined) return undefined;
  return {
    error: `treatment ${id}: delivery: "prompt" requires nudgePhrasingFile — a prompt-carried treatment must pin its message in a nudge phrasing so its meaning cannot drift with the production default wording`,
  };
}

interface ManifestFields {
  id: string;
  env: Record<string, string>;
  nudgePhrasingFile: string | undefined;
  expectedZeroNudges: boolean | undefined;
  delivery: "prompt" | "rail" | undefined;
}

function validateFields(raw: Record<string, unknown>): { fields: ManifestFields } | { error: string } {
  const id = validateId(raw.id);
  if ("error" in id) return id;

  const env = validateEnv(raw.env);
  if ("error" in env) return env;

  const nudgePhrasingFile = validateOptionalString(raw.nudgePhrasingFile, "nudgePhrasingFile");
  if ("error" in nudgePhrasingFile) return nudgePhrasingFile;

  const expectedZeroNudges = validateOptionalBoolean(raw.expectedZeroNudges, "expectedZeroNudges");
  if ("error" in expectedZeroNudges) return expectedZeroNudges;

  const delivery = validateDelivery(raw.delivery);
  if ("error" in delivery) return delivery;

  return {
    fields: {
      id: id.value,
      env: env.value,
      nudgePhrasingFile: nudgePhrasingFile.value,
      expectedZeroNudges: expectedZeroNudges.value,
      delivery: delivery.value,
    },
  };
}

function assembleManifest(fields: ManifestFields): TreatmentManifest {
  return {
    id: fields.id,
    env: fields.env,
    ...(fields.nudgePhrasingFile !== undefined ? { nudgePhrasingFile: fields.nudgePhrasingFile } : {}),
    ...(fields.expectedZeroNudges !== undefined ? { expectedZeroNudges: fields.expectedZeroNudges } : {}),
    ...(fields.delivery !== undefined ? { delivery: fields.delivery } : {}),
  };
}

function validateManifest(raw: unknown, filename: string): { manifest: TreatmentManifest } | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: `${filename}: treatment manifest must be a JSON object` };
  }

  const fieldsResult = validateFields(raw as Record<string, unknown>);
  if ("error" in fieldsResult) return { error: `${filename}: ${fieldsResult.error}` };

  const { fields } = fieldsResult;
  const railError = validateDeliveryClosesLiveRail(fields.delivery, fields.env, fields.id);
  if (railError !== undefined) return { error: `${filename}: ${railError.error}` };

  const nudgePhrasingError = validateDeliveryPinsNudgePhrasingFile(fields.delivery, fields.nudgePhrasingFile, fields.id);
  if (nudgePhrasingError !== undefined) return { error: `${filename}: ${nudgePhrasingError.error}` };

  return { manifest: assembleManifest(fields) };
}

function validateTreatmentNudgePhrasing(dir: string, manifest: TreatmentManifest): { error: string } | undefined {
  if (manifest.nudgePhrasingFile === undefined) return undefined;

  const nudgePhrasingPath = join(dir, manifest.nudgePhrasingFile);
  const bytes = readFileSync(nudgePhrasingPath, "utf8");
  const result = validateNudgePhrasing(bytes);
  if ("error" in result) {
    return { error: `treatment ${manifest.id}: invalid nudge phrasing: ${result.error}` };
  }
  return undefined;
}

function readManifests(dir: string): LoadResult {
  const filenames = readdirSync(dir).filter((f) => f.endsWith(".json"));

  const manifests: TreatmentManifest[] = [];
  const seenIds = new Set<string>();

  for (const filename of filenames) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, filename), "utf8"));
    const validated = validateManifest(raw, filename);
    if ("error" in validated) return validated;

    const { manifest } = validated;
    if (seenIds.has(manifest.id)) {
      return { error: `duplicate treatment id: ${manifest.id}` };
    }
    seenIds.add(manifest.id);

    const nudgePhrasingError = validateTreatmentNudgePhrasing(dirname(join(dir, filename)), manifest);
    if (nudgePhrasingError !== undefined) return nudgePhrasingError;

    manifests.push(manifest);
  }

  return manifests;
}

function filterByOnly(manifests: TreatmentManifest[], only: string[]): LoadResult {
  const byId = new Map(manifests.map((m) => [m.id, m]));

  const filtered: TreatmentManifest[] = [];
  for (const id of only) {
    const manifest = byId.get(id);
    if (manifest === undefined) return { error: `unknown treatment id in filter: ${id}` };
    filtered.push(manifest);
  }
  return filtered;
}

export function loadTreatments(dir: string, only?: string[]): LoadResult {
  const manifests = readManifests(dir);
  if ("error" in manifests) return manifests;

  if (only === undefined) return manifests;
  return filterByOnly(manifests, only);
}
