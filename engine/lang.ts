import type { Lang } from "./contract.ts";

const EXT_BY_LANG: Record<string, Lang> = {
  ".py": "python",
  ".pyi": "python",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".h": "cpp",
};

export function detectLang(path: string): Lang | undefined {
  const slash = path.lastIndexOf("/");
  const basename = slash === -1 ? path : path.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return EXT_BY_LANG[basename.slice(dot).toLowerCase()];
}
