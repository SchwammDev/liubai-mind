import fs from "node:fs";
import path from "node:path";
import url from "node:url";

export interface FileLines {
  executed: number[];
  missing: number[];
}

export interface Snapshot {
  files: Record<string, FileLines>;
}

interface Range {
  startOffset: number;
  endOffset: number;
  count: number;
}

interface V8Function {
  functionName?: string;
  ranges?: { startOffset: number; endOffset: number; count: number }[];
  isBlockCoverage?: boolean;
}

interface V8Script {
  url: string;
  functions?: V8Function[];
}

interface V8Document {
  result?: V8Script[];
}

interface LineCoverage {
  executed: Set<number>;
  missing: Set<number>;
}

export async function v8CoverageToSnapshot(coverageDir: string, repoRoot: string): Promise<Snapshot> {
  const repoAbs = path.resolve(repoRoot);
  const rangesByUrl = collectRangesByUrl(coverageDir);

  const files: Record<string, FileLines> = {};
  for (const [fileUrl, ranges] of rangesByUrl) {
    const absPath = resolveFileUnderRoot(fileUrl, repoAbs);
    if (absPath === undefined) continue;

    const source = await readFileText(absPath);
    const lineCoverage = computeLineCoverage(ranges, source);

    const relPath = toRelPosix(absPath, repoAbs);
    files[relPath] = {
      executed: [...lineCoverage.executed].sort((a, b) => a - b),
      missing: [...lineCoverage.missing].sort((a, b) => a - b),
    };
  }

  return { files };
}

function collectRangesByUrl(coverageDir: string): Map<string, Range[]> {
  const summed = new Map<string, Map<string, Range>>();
  for (const name of fs.readdirSync(coverageDir)) {
    if (!name.endsWith(".json")) continue;
    accumulateRanges(readJson(path.join(coverageDir, name)) as V8Document, summed);
  }
  return finalizeSummed(summed);
}

function accumulateRanges(doc: V8Document, summed: Map<string, Map<string, Range>>): void {
  for (const script of doc.result ?? []) {
    const ranges = extractRanges(script);
    if (ranges.length === 0) continue;
    const byKey = summed.get(script.url) ?? new Map<string, Range>();
    for (const r of ranges) sumRange(byKey, r);
    summed.set(script.url, byKey);
  }
}

function sumRange(byKey: Map<string, Range>, r: Range): void {
  const key = `${r.startOffset}:${r.endOffset}`;
  const existing = byKey.get(key);
  if (existing !== undefined) existing.count += r.count;
  else byKey.set(key, { ...r });
}

function finalizeSummed(summed: Map<string, Map<string, Range>>): Map<string, Range[]> {
  const result = new Map<string, Range[]>();
  for (const [fileUrl, byKey] of summed) result.set(fileUrl, [...byKey.values()]);
  return result;
}

function extractRanges(script: V8Script): Range[] {
  const ranges: Range[] = [];
  for (const fn of script.functions ?? []) {
    for (const r of fn.ranges ?? []) ranges.push({ startOffset: r.startOffset, endOffset: r.endOffset, count: r.count });
  }
  return ranges;
}

function resolveFileUnderRoot(fileUrl: string, repoAbs: string): string | undefined {
  let absPath: string;
  try {
    absPath = url.fileURLToPath(fileUrl);
  } catch {
    return undefined;
  }
  const rel = path.relative(repoAbs, absPath);
  if (rel === "" || rel.startsWith("..")) return undefined;
  const segments = rel.split(path.sep);
  if (segments.includes("node_modules")) return undefined;
  if (!fs.existsSync(absPath)) return undefined;
  return absPath;
}

function toRelPosix(absPath: string, repoAbs: string): string {
  return path.relative(repoAbs, absPath).split(path.sep).join("/");
}

function computeLineCoverage(ranges: Range[], source: string): LineCoverage {
  const lineStarts = computeLineStarts(source);
  const srcLen = source.length;
  const executed = new Set<number>();
  const missing = new Set<number>();

  for (const range of ranges) {
    for (const [start, end] of ownedIntervals(range, ranges, srcLen)) {
      const count = range.count;
      const firstLine = lineForOffset(start, lineStarts, srcLen);
      const lastLine = lineForOffset(end - 1, lineStarts, srcLen);
      for (let line = firstLine; line <= lastLine; line++) {
        if (count > 0) executed.add(line);
        else missing.add(line);
      }
    }
  }

  for (const line of executed) missing.delete(line);
  return { executed, missing };
}

function ownedIntervals(range: Range, all: Range[], srcLen: number): [number, number][] {
  const start = clamp(range.startOffset, 0, srcLen);
  const end = clamp(range.endOffset, 0, srcLen);
  if (end <= start) return [];

  const holes: [number, number][] = [];
  for (const other of all) {
    if (other === range) continue;
    if (!strictlyInside(other, range)) continue;
    const hStart = clamp(other.startOffset, start, end);
    const hEnd = clamp(other.endOffset, start, end);
    if (hEnd > hStart) holes.push([hStart, hEnd]);
  }

  return subtractIntervals(start, end, holes);
}

function strictlyInside(inner: Range, outer: Range): boolean {
  const startsInside = inner.startOffset >= outer.startOffset;
  const endsInside = inner.endOffset <= outer.endOffset;
  const isProper = inner.startOffset > outer.startOffset || inner.endOffset < outer.endOffset;
  return startsInside && endsInside && isProper;
}

function subtractIntervals(start: number, end: number, holes: [number, number][]): [number, number][] {
  const sorted = holes.filter((h) => h[1] > h[0]).sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const result: [number, number][] = [];
  let cursor = start;
  for (const [hStart, hEnd] of sorted) {
    if (hEnd <= cursor) continue;
    if (hStart >= end) break;
    if (hStart > cursor) result.push([cursor, Math.min(hStart, end)]);
    cursor = Math.max(cursor, hEnd);
  }
  if (cursor < end) result.push([cursor, end]);
  return result;
}

function computeLineStarts(source: string): number[] {
  const starts = [0, 0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineForOffset(offset: number, starts: number[], srcLen: number): number {
  const maxOffset = Math.max(0, srcLen - 1);
  const clamped = Math.max(0, Math.min(offset, maxOffset));
  let lo = 1;
  let hi = starts.length - 1;
  let line = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= clamped) {
      line = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return line;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readFileText(filePath: string): Promise<string> {
  return fs.promises.readFile(filePath, "utf8");
}
