import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadSimulatedSessionInputs,
  simulatedSessionOpeningTask,
  buildSimulatedSessionTask,
  missingSimulatedSessionInputs,
  priorDraftPath,
} from "./simulated-session.ts";
import { loadCases } from "./corpus.ts";
import type { CaseManifest } from "./eval-contract.ts";

const CORPUS_DIR = join(import.meta.dirname, "corpus");
const CASE_ID = "ts-telemetry-pipeline";

function loadRealCase(id: string): CaseManifest {
  const result = loadCases(CORPUS_DIR, [id]);
  assert.ok(Array.isArray(result), `corpus failed to load ${id}`);
  return (result as CaseManifest[])[0]!;
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fixtureCaseWithoutExtension(): CaseManifest {
  return {
    id: "fixture-case",
    lang: "typescript",
    files: ["thing.ts.case"],
    entry: "thing.ts",
    entrySymbol: "f",
    task: "Improve thing.ts. Keep the public function signature and behavior unchanged.",
    baseline: { decisionPoints: 1, functions: 1, silentHandlers: 0 },
    tier: "easy",
    probes: [{ args: [1], returns: 2 }],
  };
}

function fixtureCaseWithExtension(): CaseManifest {
  return { ...fixtureCaseWithoutExtension(), extension: { task: "Now add validation.", probes: [{ args: [1], returns: 2 }] } };
}

function writePriorDraft(corpusDir: string, kase: CaseManifest, content: string): void {
  mkdirSync(join(corpusDir, kase.id), { recursive: true });
  writeFileSync(priorDraftPath(corpusDir, kase), content);
}

function errorOf(result: unknown): string {
  assert.ok(typeof result === "object" && result !== null && "error" in result);
  return (result as { error: string }).error;
}

function assertBuiltTaskCarriesTheDraftAndExtension(built: { task: string } | { error: string }, kase: CaseManifest): void {
  assert.ok(!("error" in built), "expected a built task, got an error");
  const task = (built as { task: string }).task;
  assert.ok(task.includes(readFileSync(priorDraftPath(CORPUS_DIR, kase), "utf8")), "built task does not carry the prior draft");
  assert.ok(task.includes(kase.extension!.task), "built task does not carry the extension task");
}

test("loadSimulatedSessionInputs_reports_an_error_naming_the_case_when_the_prior_draft_file_is_missing", () => {
  const corpusDir = tempDir("simulated-session-inputs-");
  const kase = fixtureCaseWithExtension();

  const result = loadSimulatedSessionInputs(corpusDir, kase);

  assert.match(errorOf(result), new RegExp(kase.id));
});

test("loadSimulatedSessionInputs_reports_an_error_naming_the_case_when_the_extension_is_missing", () => {
  const corpusDir = tempDir("simulated-session-inputs-");
  const kase = fixtureCaseWithoutExtension();
  writePriorDraft(corpusDir, kase, "export function f(x: number): number { return x; }\n");

  const result = loadSimulatedSessionInputs(corpusDir, kase);

  assert.match(errorOf(result), new RegExp(kase.id));
});

test("loadSimulatedSessionInputs_reads_the_prior_draft_content_and_the_extension_task_when_both_are_present", () => {
  const corpusDir = tempDir("simulated-session-inputs-");
  const kase = fixtureCaseWithExtension();
  const draft = "export function f(x: number): number { return x; }\n";
  writePriorDraft(corpusDir, kase, draft);

  const result = loadSimulatedSessionInputs(corpusDir, kase);

  assert.deepEqual(result, { priorDraft: draft, extensionTask: kase.extension!.task });
});

test("simulatedSessionOpeningTask_discloses_the_simulation_and_the_research_purpose", () => {
  const kase = fixtureCaseWithExtension();

  const task = simulatedSessionOpeningTask(kase, "draft body", "extension body");

  assert.match(task, /simulated/);
  assert.match(task, /research/);
});

test("simulatedSessionOpeningTask_instructs_writing_the_draft_and_treating_it_as_the_agents_own_earlier_work_not_as_an_actual_memory", () => {
  const kase = fixtureCaseWithExtension();

  const task = simulatedSessionOpeningTask(kase, "draft body", "extension body");

  assert.ok(
    task.includes(`Write the draft below to ${kase.entry}, exactly as shown, and treat it as code you wrote earlier in this session.`),
    "opening task does not instruct the agent to treat the draft as its own earlier work",
  );
});

test("simulatedSessionOpeningTask_carries_the_prior_draft_and_the_extension_task_verbatim", () => {
  const kase = fixtureCaseWithExtension();
  const draft = "const x = 1;\nexport function f() { return x; }\n";
  const extensionTask = "Add a guard for negative input.";

  const task = simulatedSessionOpeningTask(kase, draft, extensionTask);

  assert.ok(task.includes(draft));
  assert.ok(task.includes(extensionTask));
});

test("simulatedSessionOpeningTask_never_carries_the_cases_original_improve_task", () => {
  const kase = fixtureCaseWithExtension();

  const task = simulatedSessionOpeningTask(kase, "draft body", "extension body");

  assert.ok(!task.includes(kase.task));
});

test("buildSimulatedSessionTask_combines_the_loaded_draft_and_extension_into_the_opening_task_for_a_real_hard_case", () => {
  const kase = loadRealCase(CASE_ID);

  const built = buildSimulatedSessionTask(CORPUS_DIR, kase);

  assertBuiltTaskCarriesTheDraftAndExtension(built, kase);
});

test("missingSimulatedSessionInputs_reports_undefined_when_every_case_has_a_prior_draft_and_an_extension", () => {
  const result = missingSimulatedSessionInputs(CORPUS_DIR, [loadRealCase(CASE_ID)]);

  assert.equal(result, undefined);
});

test("missingSimulatedSessionInputs_reports_the_missing_cases_error_when_a_case_lacks_a_prior_draft", () => {
  const corpusDir = tempDir("simulated-session-inputs-");
  const kase = fixtureCaseWithExtension();

  const result = missingSimulatedSessionInputs(corpusDir, [kase]);

  assert.match(result ?? "", new RegExp(kase.id));
});
