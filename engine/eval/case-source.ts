import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Extracted, Lang } from "../contract.ts";
import { typescriptExtractor } from "../extract-typescript.ts";
import { pythonExtractor } from "../extract-python.ts";
import type { CaseManifest } from "./eval-contract.ts";

export async function extractFunctions(lang: Lang, path: string, after: string): Promise<Extracted> {
  if (lang === "typescript") return await typescriptExtractor.extract({ path, after });
  if (lang === "python") return await pythonExtractor.extract({ path, after });
  throw new Error(`unsupported lang for extraction: ${lang}`);
}

export function readEntrySource(corpusDir: string, kase: CaseManifest): string {
  return readFileSync(join(corpusDir, kase.id, `${kase.entry}.case`), "utf8");
}
