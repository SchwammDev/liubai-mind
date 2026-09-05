import { test } from "node:test";
import assert from "node:assert/strict";

import { renderReportHtml } from "./report-html.ts";
import type {
  CodeStateName,
  CodeStateView,
  ExperimentDetailView,
  ExperimentView,
  RepetitionView,
  ReportViewModel,
  ReviewView,
  TreatmentView,
} from "./report-view.ts";

function viewModel(over: Partial<ReportViewModel>): ReportViewModel {
  return { milestones: [], unclaimedRunFolders: [], experimentDetails: [], ...over };
}

function experimentView(over: Partial<ExperimentView>): ExperimentView {
  return {
    id: "exp",
    name: "Exp Name",
    kindLabel: "single task",
    question: "Does it help?",
    treatmentIds: ["t1", "t2"],
    model: "deepseek-v4-flash",
    tierLabel: "hard cases",
    size: "1 case × 3 repetitions per treatment",
    status: "concluded",
    outcome: "it worked",
    identicalTreatmentsFlag: false,
    ...over,
  };
}

function experimentMarkers(html: string): { hasDataAttribute: boolean; nameIsEscaped: boolean } {
  return {
    hasDataAttribute: html.includes('data-experiment="cc-delta"'),
    nameIsEscaped: html.includes("&lt;b&gt;Name&lt;/b&gt;") && !html.includes("<b>Name</b>"),
  };
}

test("an experiment's row carries its id as a data-experiment attribute and its name is escaped", () => {
  const html = renderReportHtml(
    viewModel({ milestones: [{ milestone: "m1", experiments: [experimentView({ id: "cc-delta", name: "Exp <b>Name</b>" })] }] }),
  );

  assert.deepEqual(experimentMarkers(html), { hasDataAttribute: true, nameIsEscaped: true });
});

test("an unclaimed run folder is listed with a data-unclaimed-run attribute", () => {
  const html = renderReportHtml(viewModel({ unclaimedRunFolders: ["dry-run"] }));

  assert.equal(html.includes('data-unclaimed-run="dry-run"'), true);
});

test("no unclaimed section renders when every run folder is claimed", () => {
  const html = renderReportHtml(viewModel({ unclaimedRunFolders: [] }));

  assert.equal(html.includes("data-unclaimed-run"), false);
});

function codeState(name: CodeStateName, over: Partial<CodeStateView> = {}): CodeStateView {
  return { name, label: name, caption: `caption for ${name}`, dedupeKey: `key-${name}`, available: true, text: `text for ${name}`, ...over };
}

function review(over: Partial<ReviewView> = {}): ReviewView {
  return {
    id: "run-a/case-a/t1/1",
    verdict: "gamed",
    whyThisVerdict: "verdict gamed",
    entryFilename: "entry.py",
    codeStates: [codeState("original"), codeState("change")],
    defaultBeforeName: "original",
    defaultAfterName: "change",
    ...over,
  };
}

function repetitionView(over: Partial<RepetitionView> = {}): RepetitionView {
  return {
    id: "run-a/case-a/t1/1",
    caseId: "case-a",
    repetition: 1,
    verdict: "gamed",
    startsFromLabel: "original source",
    linesAddedRemoved: "+1 / -1",
    turns: "1",
    tokensIn: "1",
    nudges: "-",
    nudged: false,
    detail: "",
    review: review(),
    ...over,
  };
}

function treatmentView(over: Partial<TreatmentView> = {}): TreatmentView {
  return {
    treatmentId: "t1",
    run: "run-a",
    verdictDistribution: "",
    meanTurns: "-",
    meanTokensIn: "-",
    meanNudgesPerRepetition: "-",
    repetitions: [repetitionView()],
    ...over,
  };
}

function experimentDetailView(over: Partial<ExperimentDetailView> = {}): ExperimentDetailView {
  return {
    id: "exp",
    name: "Exp",
    kindLabel: "single task",
    question: "does it help?",
    outcome: "",
    treatmentIds: ["t1"],
    controlTreatmentId: "t1",
    successVerdict: "genuine-fix",
    setupCheck: { summary: "", identicalTreatments: false },
    treatments: [treatmentView()],
    perCase: [],
    ...over,
  };
}

function codeStateNamesInPageOrder(html: string): string[] {
  return [...html.matchAll(/data-code-state="([^"]+)"/g)].map((match) => match[1]!);
}

test("a repetition's review section carries the repetition's own id and its code states in view-model order", () => {
  const detail = experimentDetailView({
    treatments: [
      treatmentView({
        repetitions: [
          repetitionView({ review: review({ codeStates: [codeState("original"), codeState("earlier-change"), codeState("follow-up-change")] }) }),
        ],
      }),
    ],
  });

  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  assert.deepEqual(
    { hasReviewSection: html.includes('data-review="run-a/case-a/t1/1"'), codeStateOrder: codeStateNamesInPageOrder(html) },
    { hasReviewSection: true, codeStateOrder: ["original", "earlier-change", "follow-up-change"] },
  );
});

function pageWithRepetitionsSharingOneOriginal(repetitionCount: 1 | 2): string {
  const sharedOriginal = codeState("original", { dedupeKey: "shared-key", text: "shared original text" });
  const repetitions = [
    repetitionView({
      id: "run-a/case-a/t1/1",
      review: review({ id: "run-a/case-a/t1/1", codeStates: [sharedOriginal, codeState("change", { dedupeKey: "c1", text: "change one" })] }),
    }),
  ];
  if (repetitionCount === 2) {
    repetitions.push(
      repetitionView({
        id: "run-a/case-a/t1/2",
        repetition: 2,
        review: review({ id: "run-a/case-a/t1/2", codeStates: [sharedOriginal, codeState("change", { dedupeKey: "c2", text: "change two" })] }),
      }),
    );
  }
  const detail = experimentDetailView({ treatments: [treatmentView({ repetitions })] });
  return renderReportHtml(viewModel({ experimentDetails: [detail] }));
}

function statesPanelOf(page: string, reviewId: string): string {
  const start = page.indexOf(`data-review="${reviewId}"`);
  if (start === -1) return "";
  const end = page.indexOf('class="compare-controls"', start);
  return page.slice(start, end);
}

function occurrencesOfSharedOriginalText(page: string): number {
  const statesPanels = statesPanelOf(page, "run-a/case-a/t1/1") + statesPanelOf(page, "run-a/case-a/t1/2");
  return statesPanels.split("shared original text").length - 1;
}

test("a code state shared by two repetitions costs no extra copies of its text among the embedded states", () => {
  const withOneRepetition = occurrencesOfSharedOriginalText(pageWithRepetitionsSharingOneOriginal(1));
  const withTwoRepetitions = occurrencesOfSharedOriginalText(pageWithRepetitionsSharingOneOriginal(2));

  assert.equal(withTwoRepetitions, withOneRepetition);
});

function sectionStartingAt(page: string, marker: string): string {
  return page.slice(page.indexOf(marker));
}

test("a repetition's diff still renders when its original state was already embedded by an earlier repetition", () => {
  const page = pageWithRepetitionsSharingOneOriginal(2);
  const secondReview = sectionStartingAt(page, 'data-review="run-a/case-a/t1/2"');

  assert.equal(secondReview.includes("enable JavaScript"), false);
});

function buttonActiveFor(html: string, attribute: string, value: string): boolean {
  const match = html.match(new RegExp(`<button[^>]*${attribute}="${value}"[^>]*>`));
  return match !== null && match[0].includes("active");
}

test("the default diff is a unified view that collapses unchanged lines far from any change, instead of repeating the whole file", () => {
  const original = codeState("original", { text: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n" });
  const change = codeState("change", { text: "line 1\nline 2\nline 3\nline 4\nCHANGED\nline 6\nline 7\nline 8\nline 9\nline 10\n" });
  const detail = experimentDetailView({
    treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ codeStates: [original, change] }) })] })],
  });

  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  assert.deepEqual(
    { showsTheChangedLine: html.includes("CHANGED"), collapsesTheDistantLines: html.includes("unchanged line") },
    { showsTheChangedLine: true, collapsesTheDistantLines: true },
  );
});

test("the view-mode control defaults to unified, matching the diff already rendered without JavaScript", () => {
  const detail = experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView()] })] });

  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  assert.deepEqual(
    { unifiedActive: buttonActiveFor(html, "data-view-mode", "unified"), sideBySideActive: buttonActiveFor(html, "data-view-mode", "side-by-side") },
    { unifiedActive: true, sideBySideActive: false },
  );
});

test("the why-this-verdict box carries the literal phrase alongside the computed explanation", () => {
  const detail = experimentDetailView({
    treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ whyThisVerdict: "verdict gamed · decision points 1 → 2" }) })] })],
  });

  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  assert.deepEqual(
    { hasPhrase: html.includes("why this verdict"), hasExplanation: html.includes("verdict gamed · decision points 1 → 2") },
    { hasPhrase: true, hasExplanation: true },
  );
});

test("the reference-fix control is offered only when the review carries a reference", () => {
  const withReference = experimentDetailView({
    treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ reference: { dedupeKey: "ref-1", text: "ref text" } }) })] })],
  });
  const withoutReference = experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView({ review: review() })] })] });

  assert.deepEqual(
    {
      offeredWhenPresent: renderReportHtml(viewModel({ experimentDetails: [withReference] })).includes("reference fix"),
      offeredWhenAbsent: renderReportHtml(viewModel({ experimentDetails: [withoutReference] })).includes("reference fix"),
    },
    { offeredWhenPresent: true, offeredWhenAbsent: false },
  );
});

test("the note box renders disabled, since wiring it to serve mode is a later slice", () => {
  const detail = experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView()] })] });

  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  assert.equal(/<textarea[^>]*\bdisabled\b/.test(html), true);
});
