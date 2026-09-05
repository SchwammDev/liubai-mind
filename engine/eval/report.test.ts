import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runReport, serveReport } from "./report.ts";
import type { Experiment } from "./experiments.ts";
import type { RawRow } from "./eval-contract.ts";
import { CORPUS_DIR, tempDir, writeRun } from "./run-doubles.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const CASE_ID = "ts-telemetry-pipeline";
const ENTRY_FILE = "process_batch.ts";
const TREATMENT = "rails-default";
const UNSCORED_RUN = "unscored-run";

function unscoredRow(): RawRow {
  return {
    caseId: CASE_ID,
    treatmentId: TREATMENT,
    repetition: 1,
    provenance: {
      treatmentId: TREATMENT,
      phrasingPackHash: null,
      liubaiSha: "3250ea4",
      model: "aqueduct/deepseek-v4-flash-284b",
      collectedAt: "2026-09-05T00:00:00.000Z",
    },
    files: {},
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
  };
}

function experimentClaiming(run: string): Experiment {
  return {
    id: "exp",
    name: "Exp",
    question: "Does it help?",
    kind: "single-task",
    milestone: "m1",
    treatments: [{ treatmentId: TREATMENT, run }],
    controlTreatment: TREATMENT,
    status: "open",
    outcome: "",
    issues: [],
  };
}

function reportOn(runsRoot: string): { experimentsPath: string; corpusDir: string; runsDir: string; repoRoot: string; outPath: string } {
  return {
    runsDir: runsRoot,
    experimentsPath: join(runsRoot, "experiments.json"),
    corpusDir: CORPUS_DIR,
    repoRoot: REPO_ROOT,
    outPath: join(runsRoot, "report.html"),
  };
}

function guidanceGivenFor(status: number, stdout: string, run: string): { status: number; namesTheRun: boolean; tellsToScoreFirst: boolean } {
  return { status, namesTheRun: stdout.includes(run), tellsToScoreFirst: stdout.includes(`liubai eval score --run ${run}`) };
}

test("runReport tells the user to score a run before it can be reported on, instead of a raw ENOENT", async () => {
  const runsRoot = tempDir("report-unscored-");
  writeRun(join(runsRoot, UNSCORED_RUN), [unscoredRow()], {});
  writeFileSync(join(runsRoot, "experiments.json"), JSON.stringify([experimentClaiming(UNSCORED_RUN)]));

  const result = await runReport(reportOn(runsRoot));

  assert.deepEqual(guidanceGivenFor(result.status, result.stdout, UNSCORED_RUN), {
    status: 1,
    namesTheRun: true,
    tellsToScoreFirst: true,
  });
});

function minimalJudgedRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    caseId: CASE_ID,
    treatmentId: TREATMENT,
    repetition: 1,
    startsFrom: { kind: "original-source" },
    transcriptPath: null,
    verdict: "genuine-fix",
    gamedReason: null,
    failedBehaviorChecks: [],
    decisionPointsBefore: 10,
    decisionPointsAfter: 8,
    entrySymbolComplexityBefore: 5,
    entrySymbolComplexityAfter: 4,
    functionsBefore: 3,
    functionsAfter: 3,
    linesAdded: 1,
    linesRemoved: 1,
    turns: 2,
    tokensIn: 10,
    tokensOut: 5,
    durationMs: 1000,
    ending: "final-text",
    retries: 0,
    nudges: null,
    toolCalls: null,
    firstEditTurn: null,
    filesCreated: [],
    reasoning: { requested: null, present: false },
    contaminated: false,
    consultedRail: false,
    ...over,
  };
}

function minimalRawRow(repetition: number, files: Record<string, string>, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseId: CASE_ID,
    treatmentId: TREATMENT,
    repetition,
    provenance: { treatmentId: TREATMENT, phrasingPackHash: null, liubaiSha: "3250ea4", model: "test-model", collectedAt: "2026-09-05T00:00:00.000Z" },
    files,
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    ...over,
  };
}

function writeHandCraftedRun(runDir: string, judgedRows: Record<string, unknown>[], rawRows: Record<string, unknown>[]): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "judged.jsonl"), `${judgedRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(join(runDir, "raw.jsonl"), `${rawRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function followUpExperimentSourcedFrom(sourceRun: string, followUpRun: string): Experiment {
  return {
    id: "follow-up-exp",
    name: "Follow Up",
    question: "Does the change hold?",
    kind: "with-follow-up-tasks",
    milestone: "m1",
    sourceRun,
    treatments: [{ treatmentId: TREATMENT, run: followUpRun }],
    controlTreatment: TREATMENT,
    status: "open",
    outcome: "",
    issues: [],
  };
}

test("runReport loads an experiment's sourceRun even when no experiment claims it as a treatment, so the earlier-change state is found", async () => {
  const runsRoot = tempDir("report-source-run-");
  const SOURCE_RUN = "source-only-run";
  const FOLLOW_RUN = "follow-run";
  const EARLIER_TEXT = "function processBatch() { return 1; }\n";

  writeHandCraftedRun(
    join(runsRoot, SOURCE_RUN),
    [minimalJudgedRow({ repetition: 7 })],
    [minimalRawRow(7, { [ENTRY_FILE]: EARLIER_TEXT })],
  );
  writeHandCraftedRun(
    join(runsRoot, FOLLOW_RUN),
    [minimalJudgedRow({ startsFrom: { kind: "earlier-result", sourceRun: SOURCE_RUN, sourceRepetition: 7 } })],
    [minimalRawRow(1, { [ENTRY_FILE]: "function processBatch() { return 2; }\n" })],
  );
  writeFileSync(join(runsRoot, "experiments.json"), JSON.stringify([followUpExperimentSourcedFrom(SOURCE_RUN, FOLLOW_RUN)]));

  const result = await runReport({ ...reportOn(runsRoot) });

  assert.deepEqual(
    { status: result.status, pageMentionsEarlierChangeText: readFileSync(join(runsRoot, "report.html"), "utf8").includes(EARLIER_TEXT) },
    { status: 0, pageMentionsEarlierChangeText: true },
  );
});

test("a repetition's own transcript file on disk is embedded as a transcript island keyed by its repetition id", async () => {
  const runsRoot = tempDir("report-transcript-present-");
  const RUN = "run-with-a-transcript";

  writeHandCraftedRun(
    join(runsRoot, RUN),
    [minimalJudgedRow({ transcriptPath: "transcripts/x.jsonl" })],
    [minimalRawRow(1, { [ENTRY_FILE]: "function processBatch() { return 1; }\n" })],
  );
  mkdirSync(join(runsRoot, RUN, "transcripts"), { recursive: true });
  writeFileSync(join(runsRoot, RUN, "transcripts", "x.jsonl"), `${JSON.stringify({ type: "turn_start" })}\n${JSON.stringify({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: {} })}\n`);
  writeFileSync(join(runsRoot, "experiments.json"), JSON.stringify([experimentClaiming(RUN)]));

  const result = await runReport(reportOn(runsRoot));

  assert.deepEqual(
    { status: result.status, hasTranscriptIsland: readFileSync(join(runsRoot, "report.html"), "utf8").includes(`data-transcript="${RUN}/${CASE_ID}/${TREATMENT}/1"`) },
    { status: 0, hasTranscriptIsland: true },
  );
});

test("a repetition whose transcript file has gone missing from disk still renders the report, just without that island", async () => {
  const runsRoot = tempDir("report-missing-transcript-");
  const RUN = "run-with-a-missing-transcript";

  writeHandCraftedRun(
    join(runsRoot, RUN),
    [minimalJudgedRow({ transcriptPath: "transcripts/gone.jsonl" })],
    [minimalRawRow(1, { [ENTRY_FILE]: "function processBatch() { return 1; }\n" })],
  );
  writeFileSync(join(runsRoot, "experiments.json"), JSON.stringify([experimentClaiming(RUN)]));

  const result = await runReport(reportOn(runsRoot));

  assert.deepEqual(
    { status: result.status, hasTranscriptIsland: readFileSync(join(runsRoot, "report.html"), "utf8").includes('<script type="application/json" data-transcript="') },
    { status: 0, hasTranscriptIsland: false },
  );
});

function servedRunOn(): { runsRoot: string; runDir: string } {
  const runsRoot = tempDir("report-serve-");
  const runDir = join(runsRoot, "served-run");
  writeHandCraftedRun(
    runDir,
    [minimalJudgedRow({})],
    [minimalRawRow(1, { [ENTRY_FILE]: "function processBatch() { return 1; }\n" })],
  );
  writeFileSync(join(runsRoot, "experiments.json"), JSON.stringify([experimentClaiming("served-run")]));
  return { runsRoot, runDir };
}

function repetitionIdOf(run: string): string {
  return `${run}/${CASE_ID}/${TREATMENT}/1`;
}

function notesWrittenIn(runDir: string): Record<string, unknown>[] {
  try {
    return readFileSync(join(runDir, "notes.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

test("serveReport binds to 127.0.0.1 on an ephemeral port and serves the generated page", async () => {
  const { runsRoot } = servedRunOn();
  const server = await serveReport(reportOn(runsRoot));

  const page = await fetch(server.url);
  await server.close();

  assert.deepEqual(
    { boundToLoopback: server.url.startsWith("http://127.0.0.1:"), status: page.status, isHtml: (await page.text()).includes("<!doctype html>") },
    { boundToLoopback: true, status: 200, isHtml: true },
  );
});

test("saving a note for a known repetition writes it beside that run's judged file", async () => {
  const { runsRoot, runDir } = servedRunOn();
  const server = await serveReport(reportOn(runsRoot));

  const saved = await fetch(`${server.url}/note`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repetition: repetitionIdOf("served-run"), text: "worth a second look" }),
  });
  await server.close();

  assert.deepEqual(
    { status: saved.status, notes: notesWrittenIn(runDir).map((note) => ({ caseId: note["caseId"], treatmentId: note["treatmentId"], repetition: note["repetition"], text: note["text"] })) },
    { status: 200, notes: [{ caseId: CASE_ID, treatmentId: TREATMENT, repetition: 1, text: "worth a second look" }] },
  );
});

test("a note posted with an unknown repetition id is rejected and writes nothing", async () => {
  const { runsRoot, runDir } = servedRunOn();
  const server = await serveReport(reportOn(runsRoot));

  const rejected = await fetch(`${server.url}/note`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repetition: "no-such-run/no-such-case/no-such-treatment/1", text: "should not land" }),
  });
  await server.close();

  assert.deepEqual({ isClientError: rejected.status >= 400 && rejected.status < 500, notes: notesWrittenIn(runDir) }, { isClientError: true, notes: [] });
});

test("a malformed note body is rejected and writes nothing", async () => {
  const { runsRoot, runDir } = servedRunOn();
  const server = await serveReport(reportOn(runsRoot));

  const rejected = await fetch(`${server.url}/note`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "missing the repetition field" }),
  });
  await server.close();

  assert.deepEqual({ isClientError: rejected.status >= 400 && rejected.status < 500, notes: notesWrittenIn(runDir) }, { isClientError: true, notes: [] });
});
