import { createHash } from "node:crypto";

import type { Lang } from "../contract.ts";

const KNOWN_LANGS: readonly Lang[] = ["python", "typescript", "cpp"];

function isLang(value: string): value is Lang {
  return (KNOWN_LANGS as readonly string[]).includes(value);
}

export interface ValidPack {
  CC_ADVICE: Partial<Record<Lang, string>>;
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

function validateCcAdvice(ccAdvice: unknown): { value: Partial<Record<Lang, string>> } | { error: string } {
  if (typeof ccAdvice !== "object" || ccAdvice === null || Array.isArray(ccAdvice)) {
    return { error: "CC_ADVICE must be an object" };
  }

  const validated: Partial<Record<Lang, string>> = {};
  for (const [lang, advice] of Object.entries(ccAdvice as Record<string, unknown>)) {
    if (!isLang(lang)) return { error: `unknown lang key in CC_ADVICE: ${lang}` };
    if (typeof advice !== "string") return { error: `CC_ADVICE.${lang} must be a string` };
    validated[lang] = advice;
  }
  return { value: validated };
}

export function validatePack(raw: string): ValidatePackResult {
  const parsed = parseJson(raw);
  if ("error" in parsed) return { error: parsed.error };

  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "pack must be a JSON object" };
  }

  const entries = value as Record<string, unknown>;
  const unknownKeys = Object.keys(entries).filter((key) => key !== "CC_ADVICE");
  if (unknownKeys.length > 0) {
    return { error: `unknown top-level key(s): ${unknownKeys.join(", ")}` };
  }

  const ccAdvice = validateCcAdvice(entries.CC_ADVICE);
  if ("error" in ccAdvice) return { error: ccAdvice.error };

  return { pack: { CC_ADVICE: ccAdvice.value } };
}

export function packHash(bytes: string | null): string | null {
  if (bytes === null) return null;
  return createHash("sha256").update(bytes).digest("hex");
}
