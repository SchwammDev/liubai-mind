import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadExperiments, loadTreatmentIdsByRun, unclaimedRunFolders, validateExperiments } from "./experiments.ts";
import type { Experiment } from "./experiments.ts";
import { loadCases } from "./corpus.ts";
import type { RawRow, Tier } from "./eval-contract.ts";
import type { RepetitionRecord } from "./repetition-record.ts";
import { buildReportViewModel } from "./report-view.ts";
import type { RunRecordsForReport } from "./report-view.ts";
import { renderReportHtml } from "./report-html.ts";

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
  return [...new Set(experiments.flatMap((experiment) => experiment.treatments.map((treatment) => treatment.run)))];
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

function tierByCaseIdFrom(corpusDir: string): { map: Map<string, Tier> } | { error: string } {
  const cases = loadCases(corpusDir);
  if ("error" in cases) return { error: `report: failed to load corpus: ${cases.error}` };
  return { map: new Map(cases.map((kase) => [kase.id, kase.tier])) };
}

export async function runReport(opts: ReportOpts): Promise<ReportResult> {
  const experiments = loadExperiments(opts.experimentsPath);
  const known = { treatmentIdsByRun: loadTreatmentIdsByRun(opts.runsDir) };

  const violations = validateExperiments(experiments, known);
  if (violations.length > 0) return { status: 1, stdout: violations.join("\n") };

  const tierByCaseId = tierByCaseIdFrom(opts.corpusDir);
  if ("error" in tierByCaseId) return { status: 1, stdout: tierByCaseId.error };

  const runData = loadRunDataByFolder(opts.runsDir, runFoldersClaimedByTreatments(experiments));
  if ("error" in runData) return { status: 1, stdout: runData.error };

  const unclaimed = unclaimedRunFolders(experiments, known);

  const viewModel = buildReportViewModel(experiments, runData.runData, tierByCaseId.map, unclaimed);
  writeFileSync(opts.outPath, renderReportHtml(viewModel));

  return { status: 0, stdout: `report written: ${opts.outPath}` };
}

export async function serveReport(_opts: ReportOpts): Promise<{ url: string; close: () => Promise<void> }> {
  throw new Error("serve mode is not implemented yet");
}
