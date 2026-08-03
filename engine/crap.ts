import type { FileLines } from "./coverage-v8.ts";

export interface CrapFunction {
  name: string;
  startLine: number;
  endLine: number;
  cc: number;
}

export interface CrapInput {
  path: string;
  functions: CrapFunction[];
  hunks: [number, number][];
  coverage: FileLines | "new";
  threshold: number;
}

export interface CrapViolation {
  name: string;
  cc: number;
  cov: number;
  crap: number;
}

export function crapScore(cc: number, cov: number): number {
  return cc * cc * (1 - cov) ** 3 + cc;
}

function hunksIntersect(hunks: [number, number][], startLine: number, endLine: number): boolean {
  return hunks.some(([lo, hi]) => lo <= endLine && startLine <= hi);
}

function functionCoverage(coverage: FileLines, startLine: number, endLine: number): number {
  const inSpan = (lines: number[]): number => {
    let n = 0;
    for (const ln of lines) if (ln >= startLine && ln <= endLine) n += 1;
    return n;
  };
  const executed = inSpan(coverage.executed);
  const missing = inSpan(coverage.missing);
  const total = executed + missing;
  if (total === 0) return 1.0;
  return executed / total;
}

export function flagCrapViolations(input: CrapInput): CrapViolation[] {
  const violations: CrapViolation[] = [];
  for (const fn of input.functions) {
    if (!hunksIntersect(input.hunks, fn.startLine, fn.endLine)) continue;
    const cov = input.coverage === "new" ? 0.0 : functionCoverage(input.coverage, fn.startLine, fn.endLine);
    const crap = crapScore(fn.cc, cov);
    if (crap > input.threshold) {
      violations.push({ name: fn.name, cc: fn.cc, cov, crap });
    }
  }
  return violations;
}
