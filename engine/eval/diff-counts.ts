import type { CaseManifest } from "./eval-contract.ts";

export interface DiffCounts {
  linesAdded: number;
  linesRemoved: number;
}

function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsLength(a: string[], b: string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    previous = current;
  }
  return previous[b.length]!;
}

function changedLineCounts(before: string, after: string): DiffCounts {
  if (before === after) return { linesAdded: 0, linesRemoved: 0 };
  const a = splitLines(before);
  const b = splitLines(after);
  const common = lcsLength(a, b);
  return { linesAdded: b.length - common, linesRemoved: a.length - common };
}

export function computeDiffCounts(earlierFiles: Record<string, string>, finalFiles: Record<string, string>): DiffCounts {
  const keys = new Set([...Object.keys(earlierFiles), ...Object.keys(finalFiles)]);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const key of keys) {
    const counts = changedLineCounts(earlierFiles[key] ?? "", finalFiles[key] ?? "");
    linesAdded += counts.linesAdded;
    linesRemoved += counts.linesRemoved;
  }
  return { linesAdded, linesRemoved };
}

function isSourcePath(path: string, lang: CaseManifest["lang"]): boolean {
  if (path.startsWith("playground/")) return false;
  if (lang === "typescript") return path.endsWith(".ts");
  if (lang === "python") return path.endsWith(".py");
  return false;
}

function filterToSourceFiles(files: Record<string, string>, lang: CaseManifest["lang"]): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([path]) => isSourcePath(path, lang)));
}

export function sourceDiffCounts(earlierFiles: Record<string, string>, finalFiles: Record<string, string>, lang: CaseManifest["lang"]): DiffCounts {
  return computeDiffCounts(filterToSourceFiles(earlierFiles, lang), filterToSourceFiles(finalFiles, lang));
}
