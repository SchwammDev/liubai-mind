import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runScore } from "./score.ts";
import { routeScore } from "./follow-up-score.ts";
import { runReport, serveReport } from "./report.ts";
import type { Experiment } from "./experiments.ts";
import type { RawRow } from "./eval-contract.ts";
import { RULE } from "../contract.ts";
import {
  CORPUS_DIR,
  TREATMENTS_DIR,
  followUpSessionLogName,
  nudgeCounts,
  nudgeFired,
  pristineSourceOf,
  sessionLog,
  singleTaskSessionLogName,
  tempDir,
  toolCall,
  turnStart,
  writeRun,
} from "./run-doubles.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const CASE_ID = "ts-telemetry-pipeline";
const ENTRY_FILE = "process_batch.ts";
const CORPUS_SHA = "3250ea4";
const TREATMENT = "rails-default";
const CONTROL = "control";

const SINGLE_TASK_RUN = "numberless-hard";
const FOLLOW_UP_RUN = "numberless-hard-follow-up";
const RUN_NO_EXPERIMENT_CLAIMS = "dry-run";

const GAMED = 3;
const TIMED_OUT = 2;
const UNTOUCHED = 1;

const EXPERIMENT_QUESTION = "Does dropping the counts from the complexity nudge reduce metric gaming?";
const EXPERIMENT_OUTCOME = "numberless wording became the default";
const NOTE = "the split is cosmetic, I agree with gamed";

const HELPER_THE_FIRST_AGENT_ADDED = "\nfunction isFlatline(run: number[]): boolean {\n  return run.length >= 3;\n}\n";
const HELPER_THE_FOLLOW_UP_AGENT_ADDED = "\nfunction flatlineAlert(channel: string): string {\n  return `${channel}:flatline`;\n}\n";

type Transcript = { turns: { number: number; toolCalls: string[]; nudges: string[] }[] };

function pristineEntry(): Record<string, string> {
  return { [ENTRY_FILE]: pristineSourceOf(CASE_ID, ENTRY_FILE) };
}

function entryWith(...additions: string[]): Record<string, string> {
  return { [ENTRY_FILE]: `${pristineSourceOf(CASE_ID, ENTRY_FILE)}${additions.join("")}` };
}

function collectedRow(over: Partial<RawRow>): RawRow {
  return {
    caseId: CASE_ID,
    treatmentId: TREATMENT,
    repetition: UNTOUCHED,
    provenance: {
      treatmentId: TREATMENT,
      phrasingPackHash: null,
      liubaiSha: CORPUS_SHA,
      model: "aqueduct/deepseek-v4-flash-284b",
      collectedAt: "2026-09-05T00:00:00.000Z",
    },
    files: pristineEntry(),
    exitCode: 0,
    timedOut: false,
    durationMs: 1000,
    turns: 4,
    tokensIn: 100,
    tokensOut: 20,
    nudges: nudgeCounts({ [RULE.ccDelta]: 2 }),
    ...over,
  };
}

function sessionThatEditsOnTurnsTwoAndFourAndIsNudgedBothTimes(): string {
  return sessionLog([
    turnStart(), toolCall("read"),
    turnStart(), toolCall("edit"), nudgeFired(RULE.ccDelta),
    turnStart(), toolCall("bash"),
    turnStart(), toolCall("edit"), nudgeFired(RULE.ccDelta),
  ]);
}

function singleTaskRows(): RawRow[] {
  return [
    collectedRow({ repetition: UNTOUCHED }),
    collectedRow({ repetition: TIMED_OUT, timedOut: true, signal: "SIGTERM", exitCode: -1, files: {} }),
    collectedRow({ repetition: GAMED, files: entryWith(HELPER_THE_FIRST_AGENT_ADDED) }),
    collectedRow({ repetition: UNTOUCHED, treatmentId: CONTROL }),
  ];
}

function followUpRows(): RawRow[] {
  return [
    collectedRow({
      repetition: GAMED,
      files: entryWith(HELPER_THE_FIRST_AGENT_ADDED, HELPER_THE_FOLLOW_UP_AGENT_ADDED),
      followUp: { sourceRun: SINGLE_TASK_RUN, sourceRepetition: GAMED, control: false },
    }),
    collectedRow({
      repetition: UNTOUCHED,
      treatmentId: CONTROL,
      followUp: { sourceRun: SINGLE_TASK_RUN, sourceRepetition: null, control: true },
    }),
  ];
}

function sessionLogsFor(rows: RawRow[], nameOf: (row: RawRow) => string): Record<string, string> {
  const session = sessionThatEditsOnTurnsTwoAndFourAndIsNudgedBothTimes();
  return Object.fromEntries(rows.map((row) => [nameOf(row), session]));
}

function runsRootHoldingBothKindsAndAnUnclaimedFolder(): string {
  const runsRoot = tempDir("report-runs-");
  const single = singleTaskRows();
  const followUp = followUpRows();

  writeRun(join(runsRoot, SINGLE_TASK_RUN), single, sessionLogsFor(single, (row) => singleTaskSessionLogName(row.caseId, row.treatmentId, row.repetition)));
  writeRun(join(runsRoot, FOLLOW_UP_RUN), followUp, sessionLogsFor(followUp, (row) => followUpSessionLogName(row.caseId, row.treatmentId, row.followUp!.sourceRepetition)));
  writeRun(join(runsRoot, RUN_NO_EXPERIMENT_CLAIMS), [collectedRow({})], {});

  return runsRoot;
}

function experimentsClaimingBothRuns(): Experiment[] {
  return [
    {
      id: "numberless-prompt",
      name: "numberless prompt",
      question: EXPERIMENT_QUESTION,
      kind: "single-task",
      milestone: "coaching-over-metrics",
      treatments: [
        { treatmentId: TREATMENT, run: SINGLE_TASK_RUN },
        { treatmentId: CONTROL, run: SINGLE_TASK_RUN },
      ],
      controlTreatment: CONTROL,
      status: "concluded",
      outcome: EXPERIMENT_OUTCOME,
      issues: [60],
    },
    {
      id: "numberless-prompt-follow-up",
      name: "numberless prompt under a follow-up task",
      question: "Does the change hold up when another agent extends it?",
      kind: "with-follow-up-tasks",
      milestone: "coaching-over-metrics",
      sourceRun: SINGLE_TASK_RUN,
      treatments: [
        { treatmentId: TREATMENT, run: FOLLOW_UP_RUN },
        { treatmentId: CONTROL, run: FOLLOW_UP_RUN },
      ],
      controlTreatment: CONTROL,
      status: "open",
      outcome: "",
      issues: [73],
    },
  ];
}

interface ReportInput {
  runsDir: string;
  experimentsPath: string;
  corpusDir: string;
  repoRoot: string;
  outPath: string;
}

async function scoredRunsRoot(): Promise<ReportInput> {
  const runsRoot = runsRootHoldingBothKindsAndAnUnclaimedFolder();
  const shared = { corpusDir: CORPUS_DIR, repoRoot: REPO_ROOT, treatmentsDir: TREATMENTS_DIR };

  const single = await runScore({ runDir: join(runsRoot, SINGLE_TASK_RUN), ...shared });
  assert.equal(single.status, 0, single.stdout);
  const followUp = await routeScore({ runDir: join(runsRoot, FOLLOW_UP_RUN), ...shared }, runsRoot);
  assert.equal(followUp.status, 0, followUp.stdout);

  const experimentsPath = join(runsRoot, "experiments.json");
  writeFileSync(experimentsPath, JSON.stringify(experimentsClaimingBothRuns()));

  return { runsDir: runsRoot, experimentsPath, corpusDir: CORPUS_DIR, repoRoot: REPO_ROOT, outPath: join(runsRoot, "report.html") };
}

async function generate(input: ReportInput): Promise<string> {
  const result = await runReport(input);
  assert.equal(result.status, 0, result.stdout);
  return readFileSync(input.outPath, "utf8");
}

let theGeneratedPage: Promise<string> | undefined;

function pageOverBothKinds(): Promise<string> {
  theGeneratedPage ??= scoredRunsRoot().then(generate);
  return theGeneratedPage;
}

function repetitionId(run: string, treatmentId: string, repetition: number): string {
  return `${run}/${CASE_ID}/${treatmentId}/${repetition}`;
}

function valuesInPageOrder(page: string, attribute: string): string[] {
  return [...page.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map((match) => match[1]!);
}

function sectionFor(page: string, attribute: string, value: string): string {
  const opening = page.indexOf(`${attribute}="${value}"`);
  assert.notEqual(opening, -1, `the page carries no ${attribute} for ${value}`);
  const next = page.indexOf(`${attribute}="`, opening + 1);
  return page.slice(opening, next === -1 ? page.length : next);
}

function whatTheExperimentsListShows(page: string): unknown {
  return {
    experiments: valuesInPageOrder(page, "data-experiment"),
    questionShown: page.includes(EXPERIMENT_QUESTION),
    outcomeShown: page.includes(EXPERIMENT_OUTCOME),
    runFoldersNoExperimentClaims: valuesInPageOrder(page, "data-unclaimed-run"),
  };
}

function repetitionsUnder(page: string, run: string, treatmentId: string): string[] {
  return valuesInPageOrder(page, "data-repetition").filter((id) => id.startsWith(`${run}/`) && id.includes(`/${treatmentId}/`));
}

function whatTheReviewOffers(page: string, id: string): unknown {
  const review = sectionFor(page, "data-review", id);
  return {
    codeStates: valuesInPageOrder(review, "data-code-state"),
    showsWhatTheAgentAdded: review.includes("isFlatline"),
    namesTheVerdict: review.includes("gamed"),
    saysWhyThatVerdict: review.includes("why this verdict"),
    referenceFixOnOffer: review.includes("reference fix"),
  };
}

function whatTheFollowUpReviewCompares(page: string, id: string): unknown {
  const review = sectionFor(page, "data-review", id);
  return {
    codeStates: valuesInPageOrder(review, "data-code-state"),
    showsWhatTheFollowUpAgentAdded: review.includes("flatlineAlert"),
  };
}

function whatTheTranscriptShows(page: string, id: string): unknown {
  const island = sectionFor(page, "data-transcript", id);
  const transcript = JSON.parse(island.slice(island.indexOf(">") + 1, island.lastIndexOf("</script>"))) as Transcript;
  return {
    toolCalls: transcript.turns.flatMap((turn) => turn.toolCalls),
    complexityNudgeTurns: transcript.turns.filter((turn) => turn.nudges.includes(RULE.ccDelta)).map((turn) => turn.number),
  };
}

function whereTheNoteLanded(status: number, runsDir: string, page: string): unknown {
  const written = readFileSync(join(runsDir, SINGLE_TASK_RUN, "notes.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  return { accepted: status, savedBesideTheJudgedFile: written.map((note) => note["text"]), backOnThePage: page.includes(NOTE) };
}

test("the experiments list names every experiment, its question and outcome, and the run folders none of them claims", async () => {
  const page = await pageOverBothKinds();

  assert.deepEqual(whatTheExperimentsListShows(page), {
    experiments: ["numberless-prompt", "numberless-prompt-follow-up"],
    questionShown: true,
    outcomeShown: true,
    runFoldersNoExperimentClaims: [RUN_NO_EXPERIMENT_CLAIMS],
  });
});

test("a treatment's repetitions are listed worst first", async () => {
  const page = await pageOverBothKinds();

  assert.deepEqual(repetitionsUnder(page, SINGLE_TASK_RUN, TREATMENT), [
    repetitionId(SINGLE_TASK_RUN, TREATMENT, GAMED),
    repetitionId(SINGLE_TASK_RUN, TREATMENT, TIMED_OUT),
    repetitionId(SINGLE_TASK_RUN, TREATMENT, UNTOUCHED),
  ]);
});

test("the worst repetition opens on its diff against the original source, with the reference fix on offer", async () => {
  const page = await pageOverBothKinds();

  assert.deepEqual(whatTheReviewOffers(page, repetitionId(SINGLE_TASK_RUN, TREATMENT, GAMED)), {
    codeStates: ["original", "change"],
    showsWhatTheAgentAdded: true,
    namesTheVerdict: true,
    saysWhyThatVerdict: true,
    referenceFixOnOffer: true,
  });
});

test("a repetition's transcript carries every tool call and the turns the complexity nudge fired on", async () => {
  const page = await pageOverBothKinds();

  assert.deepEqual(whatTheTranscriptShows(page, repetitionId(SINGLE_TASK_RUN, TREATMENT, GAMED)), {
    toolCalls: ["read", "edit", "bash", "edit"],
    complexityNudgeTurns: [2, 4],
  });
});

test("a repetition built on an earlier result is reviewable against all three code states", async () => {
  const page = await pageOverBothKinds();

  assert.deepEqual(whatTheFollowUpReviewCompares(page, repetitionId(FOLLOW_UP_RUN, TREATMENT, GAMED)), {
    codeStates: ["original", "earlier-change", "follow-up-change"],
    showsWhatTheFollowUpAgentAdded: true,
  });
});

test("a note typed in serve mode lands beside the judged file and comes back on the next generation", async () => {
  const input = await scoredRunsRoot();
  const server = await serveReport(input);

  const saved = await fetch(`${server.url}/note`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repetition: repetitionId(SINGLE_TASK_RUN, TREATMENT, GAMED), text: NOTE }),
  });
  await server.close();

  assert.deepEqual(whereTheNoteLanded(saved.status, input.runsDir, await generate(input)), {
    accepted: 200,
    savedBesideTheJudgedFile: [NOTE],
    backOnThePage: true,
  });
});
