import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { typescriptExtractor } from "../extract-typescript.ts";
import { pythonExtractor } from "../extract-python.ts";
import { v8CoverageToSnapshot } from "../coverage-v8.ts";
import { runBehaviorChecksInDir } from "./behavior-checks.ts";
import type { BehaviorCheckOutcome, BehaviorCheckRunInput } from "./behavior-checks.ts";

export interface EntrySpan {
  startLine: number;
  endLine: number;
}

export interface AdequacyResult {
  outcome: BehaviorCheckOutcome;
  missingInSpan: number[];
}

async function extractedFunctions(
  lang: BehaviorCheckRunInput["lang"],
  entryFilename: string,
  source: string,
): Promise<{ name: string; startLine: number; endLine: number }[]> {
  const extractor = lang === "typescript" ? typescriptExtractor : pythonExtractor;
  const extracted = await extractor.extract({ path: entryFilename, after: source });
  return extracted.functions;
}

export async function entrySpan(
  lang: BehaviorCheckRunInput["lang"],
  entryFilename: string,
  source: string,
  entrySymbol: string,
): Promise<EntrySpan> {
  const functions = await extractedFunctions(lang, entryFilename, source);
  const fn = functions.find((f) => f.name === entrySymbol);
  if (fn === undefined) {
    throw new Error(`entrySpan: entry symbol "${entrySymbol}" was not found in ${entryFilename}`);
  }
  return { startLine: fn.startLine, endLine: fn.endLine };
}

function linesWithinSpan(lines: Iterable<number>, span: EntrySpan): number[] {
  const inSpan: number[] = [];
  for (const line of lines) {
    if (line >= span.startLine && line <= span.endLine) inSpan.push(line);
  }
  return inSpan.sort((a, b) => a - b);
}

async function runTypescriptWithCoverage(workDir: string, input: BehaviorCheckRunInput, span: EntrySpan): Promise<AdequacyResult> {
  const coverageDir = join(workDir, "v8");
  mkdirSync(coverageDir, { recursive: true });

  const outcome = runBehaviorChecksInDir(workDir, { ...input, env: { ...input.env, NODE_V8_COVERAGE: coverageDir } });

  const snapshot = await v8CoverageToSnapshot(coverageDir, workDir);
  const fileLines = snapshot.files[input.entryFilename];
  if (fileLines === undefined) {
    throw new Error(`runBehaviorChecksWithCoverage: no v8 coverage was recorded for ${input.entryFilename}; the behaviorCheck run never loaded it`);
  }

  return { outcome, missingInSpan: linesWithinSpan(fileLines.missing, span) };
}

interface PythonTrace {
  executed: number[];
  executable: number[];
}

function runPythonWithCoverage(workDir: string, input: BehaviorCheckRunInput, span: EntrySpan): AdequacyResult {
  const tracePath = join(workDir, "trace.json");

  const outcome = runBehaviorChecksInDir(workDir, { ...input, env: { ...input.env, LIUBAI_BEHAVIOR_CHECK_TRACE_OUT: tracePath } });

  if (!existsSync(tracePath)) {
    throw new Error(`runBehaviorChecksWithCoverage: no python trace was written for ${input.entryFilename}; the behaviorCheck run never loaded it`);
  }

  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as PythonTrace;
  const executed = new Set(trace.executed);
  const uncovered = trace.executable.filter((line) => !executed.has(line));

  return { outcome, missingInSpan: linesWithinSpan(uncovered, span) };
}

export async function runBehaviorChecksWithCoverage(input: BehaviorCheckRunInput): Promise<AdequacyResult> {
  const span = await entrySpan(input.lang, input.entryFilename, input.source, input.entrySymbol);

  const workDir = mkdtempSync(join(tmpdir(), "liubai-behaviorCheck-coverage-"));
  try {
    if (input.lang === "typescript") return await runTypescriptWithCoverage(workDir, input, span);
    return runPythonWithCoverage(workDir, input, span);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
