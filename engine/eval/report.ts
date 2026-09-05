import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { loadExperiments, loadTreatmentIdsByRun, unclaimedRunFolders, validateExperiments } from "./experiments.ts";
import type { Experiment } from "./experiments.ts";
import { loadCases } from "./corpus.ts";
import type { RawRow } from "./eval-contract.ts";
import type { RepetitionRecord } from "./repetition-record.ts";
import { buildReportViewModel } from "./report-view.ts";
import type { CaseFactsForReport, RunRecordsForReport } from "./report-view.ts";
import { renderReportHtml } from "./report-html.ts";
import { showFileAtCommit } from "./provenance.ts";
import type { FileAtCommit } from "./provenance.ts";

const JUDGED_FILENAME = "judged.jsonl";
const RAW_FILENAME = "raw.jsonl";

export interface ReportOpts {
  runsDir: string;
  experimentsPath: string;
  corpusDir: string;
  repoRoot: string;
  outPath: string;
}

export interface ReportResult {
  status: number;
  stdout: string;
}

function parseJsonlFile<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function unscoredRunMessage(run: string): string {
  return `report: run "${run}" has no judged.jsonl yet — run "liubai eval score --run ${run}" first`;
}

function loadRunData(runDir: string, run: string): { data: RunRecordsForReport } | { error: string } {
  let judged: RepetitionRecord[];
  try {
    judged = parseJsonlFile<RepetitionRecord>(join(runDir, JUDGED_FILENAME));
  } catch (err) {
    if (isEnoent(err)) return { error: unscoredRunMessage(run) };
    throw err;
  }

  return { data: { judged, raw: parseJsonlFile<RawRow>(join(runDir, RAW_FILENAME)) } };
}

function runFoldersClaimedByTreatments(experiments: Experiment[]): string[] {
  const treatmentRuns = experiments.flatMap((experiment) => experiment.treatments.map((treatment) => treatment.run));
  const sourceRuns = experiments.map((experiment) => experiment.sourceRun).filter((run): run is string => run !== undefined);
  return [...new Set([...treatmentRuns, ...sourceRuns])];
}

function loadRunDataByFolder(runsDir: string, runFolders: string[]): { runData: Map<string, RunRecordsForReport> } | { error: string } {
  const runData = new Map<string, RunRecordsForReport>();

  for (const run of runFolders) {
    const loaded = loadRunData(join(runsDir, run), run);
    if ("error" in loaded) return { error: loaded.error };
    runData.set(run, loaded.data);
  }

  return { runData };
}

function caseFactsByCaseIdFrom(corpusDir: string): { map: Map<string, CaseFactsForReport> } | { error: string } {
  const cases = loadCases(corpusDir);
  if ("error" in cases) return { error: `report: failed to load corpus: ${cases.error}` };
  return {
    map: new Map(
      cases.map((kase) => [
        kase.id,
        { tier: kase.tier, entry: kase.entry, ...(kase.reference !== undefined ? { reference: kase.reference } : {}) },
      ]),
    ),
  };
}

function corpusPathFor(repoRoot: string, corpusDir: string, caseId: string, entry: string): string {
  return join(relative(repoRoot, corpusDir), caseId, `${entry}.case`);
}

function originalSourceByKeyFrom(
  repoRoot: string,
  corpusDir: string,
  caseFactsByCaseId: Map<string, CaseFactsForReport>,
  runData: Map<string, RunRecordsForReport>,
): Map<string, FileAtCommit> {
  const resolved = new Map<string, FileAtCommit>();

  for (const records of runData.values()) {
    for (const row of records.raw) {
      const caseFacts = caseFactsByCaseId.get(row.caseId);
      if (caseFacts === undefined) continue;

      const key = `${row.caseId}\0${row.provenance.liubaiSha}`;
      if (resolved.has(key)) continue;

      const path = corpusPathFor(repoRoot, corpusDir, row.caseId, caseFacts.entry);
      resolved.set(key, showFileAtCommit(repoRoot, row.provenance.liubaiSha, path));
    }
  }

  return resolved;
}

function readSessionLogIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

function sessionLogByKeyFrom(runsDir: string, runData: Map<string, RunRecordsForReport>): Map<string, string> {
  const logs = new Map<string, string>();

  for (const [run, records] of runData) {
    for (const record of records.judged) {
      if (record.transcriptPath === null) continue;

      const log = readSessionLogIfPresent(join(runsDir, run, record.transcriptPath));
      if (log !== undefined) logs.set(`${run}/${record.caseId}/${record.treatmentId}/${record.repetition}`, log);
    }
  }

  return logs;
}

export async function runReport(opts: ReportOpts): Promise<ReportResult> {
  const experiments = loadExperiments(opts.experimentsPath);
  const known = { treatmentIdsByRun: loadTreatmentIdsByRun(opts.runsDir) };

  const violations = validateExperiments(experiments, known);
  if (violations.length > 0) return { status: 1, stdout: violations.join("\n") };

  const caseFacts = caseFactsByCaseIdFrom(opts.corpusDir);
  if ("error" in caseFacts) return { status: 1, stdout: caseFacts.error };

  const runData = loadRunDataByFolder(opts.runsDir, runFoldersClaimedByTreatments(experiments));
  if ("error" in runData) return { status: 1, stdout: runData.error };

  const unclaimed = unclaimedRunFolders(experiments, known);
  const originalSourceByKey = originalSourceByKeyFrom(opts.repoRoot, opts.corpusDir, caseFacts.map, runData.runData);
  const sessionLogByKey = sessionLogByKeyFrom(opts.runsDir, runData.runData);

  const viewModel = buildReportViewModel(experiments, runData.runData, caseFacts.map, unclaimed, originalSourceByKey, sessionLogByKey);
  writeFileSync(opts.outPath, renderReportHtml(viewModel));

  return { status: 0, stdout: `report written: ${opts.outPath}` };
}

export async function serveReport(_opts: ReportOpts): Promise<{ url: string; close: () => Promise<void> }> {
  throw new Error("serve mode is not implemented yet");
}
