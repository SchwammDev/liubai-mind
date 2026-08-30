import { createHash } from "node:crypto";

import type { Lang } from "../contract.ts";

const KNOWN_LANGS: readonly Lang[] = ["python", "typescript", "cpp"];

function isLang(value: string): value is Lang {
  return (KNOWN_LANGS as readonly string[]).includes(value);
}

export interface CcNudgeEntry {
  first: string;
  rest: string;
}

export interface ValidPack {
  CC_NUDGE?: Partial<Record<Lang, CcNudgeEntry>>;
  CC_DELTA_NUDGE?: string;
}

export type ValidatePackResult = { pack: ValidPack } | { error: string };

function parseJson(raw: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: `invalid json: ${reason}` };
  }
}

function validateEntry(lang: string, entry: unknown): { value: CcNudgeEntry } | { error: string } {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { error: `CC_NUDGE.${lang} must be an object with first and rest` };
  }

  const record = entry as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "first" && key !== "rest");
  if (unknownKeys.length > 0) {
    return { error: `unknown key(s) in CC_NUDGE.${lang}: ${unknownKeys.join(", ")}` };
  }

  const { first, rest } = record;
  if (typeof first !== "string") return { error: `CC_NUDGE.${lang}.first must be a string` };
  if (typeof rest !== "string") return { error: `CC_NUDGE.${lang}.rest must be a string` };
  return { value: { first, rest } };
}

function validateCcNudge(ccNudge: unknown): { value: Partial<Record<Lang, CcNudgeEntry>> } | { error: string } {
  if (typeof ccNudge !== "object" || ccNudge === null || Array.isArray(ccNudge)) {
    return { error: "CC_NUDGE must be an object" };
  }

  const validated: Partial<Record<Lang, CcNudgeEntry>> = {};
  for (const [lang, entry] of Object.entries(ccNudge as Record<string, unknown>)) {
    if (!isLang(lang)) return { error: `unknown lang key in CC_NUDGE: ${lang}` };
    const result = validateEntry(lang, entry);
    if ("error" in result) return result;
    validated[lang] = result.value;
  }
  return { value: validated };
}

function validateCcDeltaNudge(value: unknown): { value: string } | { error: string } {
  if (typeof value !== "string" || value.length === 0) {
    return { error: "CC_DELTA_NUDGE must be a non-empty string" };
  }
  return { value };
}

export function validatePack(raw: string): ValidatePackResult {
  const parsed = parseJson(raw);
  if ("error" in parsed) return { error: parsed.error };

  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "pack must be a JSON object" };
  }

  const entries = value as Record<string, unknown>;
  const unknownKeys = Object.keys(entries).filter((key) => key !== "CC_NUDGE" && key !== "CC_DELTA_NUDGE");
  if (unknownKeys.length > 0) {
    return { error: `unknown top-level key(s): ${unknownKeys.join(", ")}` };
  }

  const pack: ValidPack = {};

  if ("CC_NUDGE" in entries) {
    const ccNudge = validateCcNudge(entries.CC_NUDGE);
    if ("error" in ccNudge) return { error: ccNudge.error };
    pack.CC_NUDGE = ccNudge.value;
  }

  if ("CC_DELTA_NUDGE" in entries) {
    const ccDeltaNudge = validateCcDeltaNudge(entries.CC_DELTA_NUDGE);
    if ("error" in ccDeltaNudge) return { error: ccDeltaNudge.error };
    pack.CC_DELTA_NUDGE = ccDeltaNudge.value;
  }

  return { pack };
}

export function packHash(bytes: string | null): string | null {
  if (bytes === null) return null;
  return createHash("sha256").update(bytes).digest("hex");
}
