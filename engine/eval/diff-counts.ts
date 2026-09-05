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

export type LineDiffOp = { op: "same" | "add" | "del"; text: string };

function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i]![j] = a[i - 1] === b[j - 1] ? table[i - 1]![j - 1]! + 1 : Math.max(table[i - 1]![j]!, table[i]![j - 1]!);
    }
  }
  return table;
}

function backtrackLineDiff(a: string[], b: string[], table: number[][]): LineDiffOp[] {
  const ops: LineDiffOp[] = [];
  let i = a.length;
  let j = b.length;

  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ op: "same", text: a[i - 1]! });
      i--;
      j--;
    } else if (table[i]![j - 1]! >= table[i - 1]![j]!) {
      ops.push({ op: "add", text: b[j - 1]! });
      j--;
    } else {
      ops.push({ op: "del", text: a[i - 1]! });
      i--;
    }
  }
  while (i > 0) {
    ops.push({ op: "del", text: a[i - 1]! });
    i--;
  }
  while (j > 0) {
    ops.push({ op: "add", text: b[j - 1]! });
    j--;
  }

  return ops.reverse();
}

function commonPrefixLength(a: string[], b: string[]): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return length;
}

function commonSuffixLength(a: string[], b: string[], prefixLength: number): number {
  let length = 0;
  while (
    length < a.length - prefixLength &&
    length < b.length - prefixLength &&
    a[a.length - 1 - length] === b[b.length - 1 - length]
  ) {
    length++;
  }
  return length;
}

function diffLines(a: string[], b: string[]): LineDiffOp[] {
  const prefixLength = commonPrefixLength(a, b);
  const suffixLength = commonSuffixLength(a, b, prefixLength);

  const aMiddle = a.slice(prefixLength, a.length - suffixLength);
  const bMiddle = b.slice(prefixLength, b.length - suffixLength);
  const middleOps = backtrackLineDiff(aMiddle, bMiddle, lcsTable(aMiddle, bMiddle));

  const prefixOps: LineDiffOp[] = a.slice(0, prefixLength).map((text) => ({ op: "same", text }));
  const suffixOps: LineDiffOp[] = a.slice(a.length - suffixLength).map((text) => ({ op: "same", text }));

  return [...prefixOps, ...middleOps, ...suffixOps];
}

export function lineDiff(before: string, after: string): LineDiffOp[] {
  return diffLines(splitLines(before), splitLines(after));
}

export type ContextDiffLine = LineDiffOp | { op: "skip"; count: number };

function contextIndicesToKeep(ops: LineDiffOp[], contextLines: number): boolean[] {
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.op === "same") return;
    for (let i = Math.max(0, index - contextLines); i <= Math.min(ops.length - 1, index + contextLines); i++) keep[i] = true;
  });
  return keep;
}

export function contextDiff(before: string, after: string, contextLines: number): ContextDiffLine[] {
  const ops = lineDiff(before, after);
  const keep = contextIndicesToKeep(ops, contextLines);

  const segments: ContextDiffLine[] = [];
  let skipped = 0;
  for (let i = 0; i < ops.length; i++) {
    if (!keep[i]!) {
      skipped++;
      continue;
    }
    if (skipped > 0) {
      segments.push({ op: "skip", count: skipped });
      skipped = 0;
    }
    segments.push(ops[i]!);
  }
  if (skipped > 0) segments.push({ op: "skip", count: skipped });

  return segments;
}
