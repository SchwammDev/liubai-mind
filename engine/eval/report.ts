import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

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
const NOTES_FILENAME = "notes.jsonl";

export interface ReportOpts {
  runsDir: string;
  experimentsPath: string;
  corpusDir: string;
  repoRoot: string;
  outPath: string;
  port?: number;
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
        {
          tier: kase.tier,
          entry: kase.entry,
          behaviorChecksTotal: kase.behaviorChecks.length,
          ...(kase.reference !== undefined ? { reference: kase.reference } : {}),
          ...(kase.extension !== undefined ? { extensionBehaviorChecksTotal: kase.extension.behaviorChecks.length } : {}),
        },
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

interface NoteRecord {
  caseId: string;
  treatmentId: string;
  repetition: number;
  text: string;
  savedAt: string;
}

function parseNotesFile(path: string): NoteRecord[] {
  try {
    return parseJsonlFile<NoteRecord>(path);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

function notesByKeyFrom(runsDir: string, runFolders: string[]): Map<string, string[]> {
  const notes = new Map<string, string[]>();

  for (const run of runFolders) {
    for (const note of parseNotesFile(join(runsDir, run, NOTES_FILENAME))) {
      const id = `${run}/${note.caseId}/${note.treatmentId}/${note.repetition}`;
      const existing = notes.get(id);
      if (existing === undefined) notes.set(id, [note.text]);
      else existing.push(note.text);
    }
  }

  return notes;
}

interface KnownRepetition {
  run: string;
  caseId: string;
  treatmentId: string;
  repetition: number;
}

function knownRepetitionsFrom(runData: Map<string, RunRecordsForReport>): Map<string, KnownRepetition> {
  const known = new Map<string, KnownRepetition>();

  for (const [run, records] of runData) {
    for (const record of records.judged) {
      const id = `${run}/${record.caseId}/${record.treatmentId}/${record.repetition}`;
      known.set(id, { run, caseId: record.caseId, treatmentId: record.treatmentId, repetition: record.repetition });
    }
  }

  return known;
}

interface ReportInputs {
  experiments: Experiment[];
  caseFactsByCaseId: Map<string, CaseFactsForReport>;
  runData: Map<string, RunRecordsForReport>;
  unclaimed: string[];
  originalSourceByKey: Map<string, FileAtCommit>;
  sessionLogByKey: Map<string, string>;
  notesByKey: Map<string, string[]>;
  known: Map<string, KnownRepetition>;
}

function loadReportInputs(opts: ReportOpts): ReportInputs | { error: string } {
  const experiments = loadExperiments(opts.experimentsPath);
  const known = { treatmentIdsByRun: loadTreatmentIdsByRun(opts.runsDir) };

  const violations = validateExperiments(experiments, known);
  if (violations.length > 0) return { error: violations.join("\n") };

  const caseFacts = caseFactsByCaseIdFrom(opts.corpusDir);
  if ("error" in caseFacts) return { error: caseFacts.error };

  const runFolders = runFoldersClaimedByTreatments(experiments);
  const runData = loadRunDataByFolder(opts.runsDir, runFolders);
  if ("error" in runData) return { error: runData.error };

  const unclaimed = unclaimedRunFolders(experiments, known);
  const originalSourceByKey = originalSourceByKeyFrom(opts.repoRoot, opts.corpusDir, caseFacts.map, runData.runData);
  const sessionLogByKey = sessionLogByKeyFrom(opts.runsDir, runData.runData);
  const notesByKey = notesByKeyFrom(opts.runsDir, runFolders);
  const knownRepetitions = knownRepetitionsFrom(runData.runData);

  return {
    experiments,
    caseFactsByCaseId: caseFacts.map,
    runData: runData.runData,
    unclaimed,
    originalSourceByKey,
    sessionLogByKey,
    notesByKey,
    known: knownRepetitions,
  };
}

function reportHtmlFrom(loaded: ReportInputs, live: boolean): string {
  const viewModel = buildReportViewModel(
    loaded.experiments,
    loaded.runData,
    loaded.caseFactsByCaseId,
    loaded.unclaimed,
    loaded.originalSourceByKey,
    loaded.sessionLogByKey,
    loaded.notesByKey,
    live,
  );
  return renderReportHtml(viewModel);
}

export async function runReport(opts: ReportOpts): Promise<ReportResult> {
  const loaded = loadReportInputs(opts);
  if ("error" in loaded) return { status: 1, stdout: loaded.error };

  writeFileSync(opts.outPath, reportHtmlFrom(loaded, false));

  return { status: 0, stdout: `report written: ${opts.outPath}` };
}

function respondWith(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function bodyTextOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface NoteSubmission {
  repetitionId: string;
  text: string;
}

function parseNoteSubmission(raw: string): NoteSubmission | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { repetition, text } = parsed as Record<string, unknown>;
  if (typeof repetition !== "string" || typeof text !== "string") return undefined;

  return { repetitionId: repetition, text };
}

function appendNoteToRunFolder(runsDir: string, target: KnownRepetition, text: string): void {
  const note: NoteRecord = { caseId: target.caseId, treatmentId: target.treatmentId, repetition: target.repetition, text, savedAt: new Date().toISOString() };
  appendFileSync(join(runsDir, target.run, NOTES_FILENAME), `${JSON.stringify(note)}\n`);
}

async function handleSaveNote(req: IncomingMessage, res: ServerResponse, runsDir: string, known: Map<string, KnownRepetition>): Promise<void> {
  const submission = parseNoteSubmission(await bodyTextOf(req));
  if (submission === undefined) {
    respondWith(res, 400, "malformed note body: expected JSON {repetition, text}");
    return;
  }

  const target = known.get(submission.repetitionId);
  if (target === undefined) {
    respondWith(res, 404, `unknown repetition: ${submission.repetitionId}`);
    return;
  }

  appendNoteToRunFolder(runsDir, target, submission.text);
  respondWith(res, 200, "note saved");
}

function formatServeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requestHandlerFor(html: string, runsDir: string, known: Map<string, KnownRepetition>) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method === "POST" && req.url === "/note") {
      handleSaveNote(req, res, runsDir, known).catch((err) => respondWith(res, 500, formatServeError(err)));
      return;
    }

    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    respondWith(res, 404, "not found");
  };
}

function listenOn(server: Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}

function boundUrlOf(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("report server failed to bind to a port");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

export async function serveReport(opts: ReportOpts): Promise<{ url: string; close: () => Promise<void> }> {
  const loaded = loadReportInputs(opts);
  if ("error" in loaded) throw new Error(loaded.error);

  const html = reportHtmlFrom(loaded, true);
  const server = createServer(requestHandlerFor(html, opts.runsDir, loaded.known));
  await listenOn(server, opts.port ?? 0);

  return { url: boundUrlOf(server), close: () => closeServer(server) };
}
