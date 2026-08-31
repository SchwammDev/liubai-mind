import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ConditionManifest } from "./eval-contract.ts";
import { validatePack } from "./phrasing.ts";

type LoadResult = ConditionManifest[] | { error: string };

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((v) => typeof v === "string");
}

function validateId(id: unknown): { value: string } | { error: string } {
  if (typeof id !== "string" || id.length === 0) return { error: "condition id must be a non-empty string" };
  return { value: id };
}

function validateEnv(env: unknown): { value: Record<string, string> } | { error: string } {
  if (!isStringRecord(env)) return { error: "condition env must be an object of string values" };
  return { value: env };
}

function validateOptionalString(value: unknown, label: string): { value: string | undefined } | { error: string } {
  if (value === undefined) return { value: undefined };
  if (typeof value !== "string") return { error: `condition ${label} must be a string` };
  return { value };
}

function validateOptionalBoolean(value: unknown, label: string): { value: boolean | undefined } | { error: string } {
  if (value === undefined) return { value: undefined };
  if (typeof value !== "boolean") return { error: `condition ${label} must be a boolean` };
  return { value };
}

function validateDelivery(value: unknown): { value: "prompt" | "rail" | undefined } | { error: string } {
  if (value === undefined) return { value: undefined };
  if (value === "prompt" || value === "rail") return { value };
  return { error: `condition delivery must be "prompt" or "rail", got: ${JSON.stringify(value)}` };
}

function validateDeliveryClosesLiveRail(
  delivery: "prompt" | "rail" | undefined,
  env: Record<string, string>,
  id: string,
): { error: string } | undefined {
  if (delivery !== "prompt") return undefined;
  if (env.LIUBAI_RAILS_OFF !== undefined) return undefined;
  return {
    error: `condition ${id}: delivery: "prompt" requires env.LIUBAI_RAILS_OFF — a prompt-carried arm must close the live rail so the prompt is the only treatment channel`,
  };
}

interface ManifestFields {
  id: string;
  env: Record<string, string>;
  phrasingPack: string | undefined;
  expectedZeroFirings: boolean | undefined;
  delivery: "prompt" | "rail" | undefined;
}

function validateFields(raw: Record<string, unknown>): { fields: ManifestFields } | { error: string } {
  const id = validateId(raw.id);
  if ("error" in id) return id;

  const env = validateEnv(raw.env);
  if ("error" in env) return env;

  const phrasingPack = validateOptionalString(raw.phrasingPack, "phrasingPack");
  if ("error" in phrasingPack) return phrasingPack;

  const expectedZeroFirings = validateOptionalBoolean(raw.expectedZeroFirings, "expectedZeroFirings");
  if ("error" in expectedZeroFirings) return expectedZeroFirings;

  const delivery = validateDelivery(raw.delivery);
  if ("error" in delivery) return delivery;

  return {
    fields: {
      id: id.value,
      env: env.value,
      phrasingPack: phrasingPack.value,
      expectedZeroFirings: expectedZeroFirings.value,
      delivery: delivery.value,
    },
  };
}

function assembleManifest(fields: ManifestFields): ConditionManifest {
  return {
    id: fields.id,
    env: fields.env,
    ...(fields.phrasingPack !== undefined ? { phrasingPack: fields.phrasingPack } : {}),
    ...(fields.expectedZeroFirings !== undefined ? { expectedZeroFirings: fields.expectedZeroFirings } : {}),
    ...(fields.delivery !== undefined ? { delivery: fields.delivery } : {}),
  };
}

function validateManifest(raw: unknown, filename: string): { manifest: ConditionManifest } | { error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { error: `${filename}: condition manifest must be a JSON object` };
  }

  const fieldsResult = validateFields(raw as Record<string, unknown>);
  if ("error" in fieldsResult) return { error: `${filename}: ${fieldsResult.error}` };

  const { fields } = fieldsResult;
  const railError = validateDeliveryClosesLiveRail(fields.delivery, fields.env, fields.id);
  if (railError !== undefined) return { error: `${filename}: ${railError.error}` };

  return { manifest: assembleManifest(fields) };
}

function validatePhrasingPack(dir: string, manifest: ConditionManifest): { error: string } | undefined {
  if (manifest.phrasingPack === undefined) return undefined;

  const packPath = join(dir, manifest.phrasingPack);
  const bytes = readFileSync(packPath, "utf8");
  const result = validatePack(bytes);
  if ("error" in result) {
    return { error: `condition ${manifest.id}: invalid phrasing pack: ${result.error}` };
  }
  return undefined;
}

function readManifests(dir: string): LoadResult {
  const filenames = readdirSync(dir).filter((f) => f.endsWith(".json"));

  const manifests: ConditionManifest[] = [];
  const seenIds = new Set<string>();

  for (const filename of filenames) {
    const raw: unknown = JSON.parse(readFileSync(join(dir, filename), "utf8"));
    const validated = validateManifest(raw, filename);
    if ("error" in validated) return validated;

    const { manifest } = validated;
    if (seenIds.has(manifest.id)) {
      return { error: `duplicate condition id: ${manifest.id}` };
    }
    seenIds.add(manifest.id);

    const packError = validatePhrasingPack(dirname(join(dir, filename)), manifest);
    if (packError !== undefined) return packError;

    manifests.push(manifest);
  }

  return manifests;
}

function filterByOnly(manifests: ConditionManifest[], only: string[]): LoadResult {
  const byId = new Map(manifests.map((m) => [m.id, m]));

  const filtered: ConditionManifest[] = [];
  for (const id of only) {
    const manifest = byId.get(id);
    if (manifest === undefined) return { error: `unknown condition id in filter: ${id}` };
    filtered.push(manifest);
  }
  return filtered;
}

export function loadConditions(dir: string, only?: string[]): LoadResult {
  const manifests = readManifests(dir);
  if ("error" in manifests) return manifests;

  if (only === undefined) return manifests;
  return filterByOnly(manifests, only);
}
