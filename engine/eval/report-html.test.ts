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
import type { TranscriptTurnView, TranscriptView } from "./session-log.ts";

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

test("the views are hidden before any of them reaches the page, so a load never paints every section first", () => {
  const html = renderReportHtml(viewModel({ unclaimedRunFolders: ["dry-run"] }));

  assert.equal(html.indexOf('classList.add("js-nav")') < html.indexOf("data-view="), true);
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
    notes: [],
    live: false,
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
    tierLabel: "hard cases",
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

test("the note box renders disabled when the review is not live", () => {
  const detail = experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView()] })] });

  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  assert.equal(/<textarea[^>]*\bdisabled\b/.test(html), true);
});

test("a live review's note box offers a save control instead of the disabled placeholder", () => {
  const detail = experimentDetailView({
    treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ live: true }) })] })],
  });

  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  assert.deepEqual(
    { hasSaveControl: html.includes("data-save-note"), textareaDisabled: /<textarea[^>]*\bdisabled\b/.test(html) },
    { hasSaveControl: true, textareaDisabled: false },
  );
});

test("a live note box carries its own repetition id so the client posts to the right place", () => {
  const detail = experimentDetailView({
    treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ id: "run-a/case-a/t1/9", live: true }) })] })],
  });

  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  assert.equal(html.includes('data-note-box="run-a/case-a/t1/9"'), true);
});

test("a saved note appears in the note box, escaped, whether or not the review is live", () => {
  const staticHtml = renderReportHtml(
    viewModel({ experimentDetails: [experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ notes: ["<script>bad</script>"] }) })] })] })] }),
  );
  const liveHtml = renderReportHtml(
    viewModel({ experimentDetails: [experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ notes: ["<script>bad</script>"], live: true }) })] })] })] }),
  );

  assert.deepEqual(
    { staticEscaped: staticHtml.includes("&lt;script&gt;bad&lt;/script&gt;"), liveEscaped: liveHtml.includes("&lt;script&gt;bad&lt;/script&gt;") },
    { staticEscaped: true, liveEscaped: true },
  );
});

function transcriptTurn(over: Partial<TranscriptTurnView> = {}): TranscriptTurnView {
  return {
    number: 1,
    userText: null,
    assistantText: null,
    thinking: null,
    isFinal: false,
    isRetryFailure: false,
    toolCalls: [],
    toolCallDetails: [],
    nudges: [],
    tokensIn: null,
    tokensOut: null,
    ...over,
  };
}

function transcript(over: Partial<TranscriptView> = {}): TranscriptView {
  return { turns: [transcriptTurn()], reasoningPresent: false, ...over };
}

function pageWithOneReviewCarrying(over: Partial<ReviewView>): string {
  const detail = experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView({ review: review(over) })] })] });
  return renderReportHtml(viewModel({ experimentDetails: [detail] }));
}

function bodyOnly(page: string): string {
  return page.replace(/<script[\s\S]*?<\/script>/g, "");
}

function transcriptIslandJson(page: string, id: string): unknown {
  const opening = page.indexOf(`data-transcript="${id}"`);
  assert.notEqual(opening, -1, `the page carries no data-transcript for ${id}`);
  const start = page.indexOf(`data-transcript="`, opening);
  const next = page.indexOf(`data-transcript="`, start + 1);
  const island = page.slice(start, next === -1 ? page.length : next);
  return JSON.parse(island.slice(island.indexOf(">") + 1, island.lastIndexOf("</script>")));
}

test("a review with a transcript offers an open-transcript control and a raw transcript file link", () => {
  const html = bodyOnly(pageWithOneReviewCarrying({ transcript: transcript(), rawTranscriptHref: "run-a/transcripts/x.jsonl" }));

  assert.deepEqual(
    { hasOpenControl: html.includes("open transcript"), hasRawLink: html.includes('href="run-a/transcripts/x.jsonl"') },
    { hasOpenControl: true, hasRawLink: true },
  );
});

test("a review's transcript island parses back into the same turns it was given", () => {
  const html = pageWithOneReviewCarrying({
    id: "run-a/case-a/t1/1",
    transcript: transcript({ turns: [transcriptTurn({ number: 1, toolCalls: ["bash"] }), transcriptTurn({ number: 2, toolCalls: ["edit"], nudges: ["cc-delta"] })] }),
  });

  const parsed = transcriptIslandJson(html, "run-a/case-a/t1/1") as TranscriptView;

  assert.deepEqual(
    parsed.turns.map((turn) => turn.toolCalls),
    [["bash"], ["edit"]],
  );
});

test("the last of several transcript islands on the page still parses cleanly, even with global scripts on the page", () => {
  const detail = experimentDetailView({
    treatments: [
      treatmentView({
        repetitions: [
          repetitionView({ id: "run-a/case-a/t1/1", review: review({ id: "run-a/case-a/t1/1", transcript: transcript({ turns: [transcriptTurn({ toolCalls: ["read"] })] }) }) }),
          repetitionView({
            id: "run-a/case-a/t1/2",
            repetition: 2,
            review: review({ id: "run-a/case-a/t1/2", transcript: transcript({ turns: [transcriptTurn({ toolCalls: ["write"] })] }) }),
          }),
        ],
      }),
    ],
  });

  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));
  const last = transcriptIslandJson(html, "run-a/case-a/t1/2") as TranscriptView;

  assert.deepEqual(last.turns[0]!.toolCalls, ["write"]);
});

test("a review with no transcript offers no open-transcript control, but still names the reason", () => {
  const html = bodyOnly(pageWithOneReviewCarrying({}));

  assert.deepEqual(
    { hasOpenControl: html.includes("open transcript"), mentionsNoTranscript: html.includes("no transcript recorded") },
    { hasOpenControl: false, mentionsNoTranscript: true },
  );
});

test("a review whose transcript file could not be read still offers the raw link, with a note instead of the viewer", () => {
  const html = bodyOnly(pageWithOneReviewCarrying({ rawTranscriptHref: "run-a/transcripts/x.jsonl" }));

  assert.deepEqual(
    { hasOpenControl: html.includes("open transcript"), hasRawLink: html.includes('href="run-a/transcripts/x.jsonl"') },
    { hasOpenControl: false, hasRawLink: true },
  );
});

test("the thinking toggle is disabled and says not recorded when the transcript carries no reasoning", () => {
  const html = pageWithOneReviewCarrying({ transcript: transcript({ reasoningPresent: false }) });

  assert.deepEqual(
    { toggleDisabled: /<button[^>]*disabled[^>]*>\s*thinking/.test(html), saysNotRecorded: html.includes("not recorded") },
    { toggleDisabled: true, saysNotRecorded: true },
  );
});

test("the thinking toggle is enabled when the transcript carries reasoning", () => {
  const html = pageWithOneReviewCarrying({ transcript: transcript({ reasoningPresent: true }) });

  const toggleIsEnabled = /<button[^>]*data-toggle-thinking[^>]*>/.test(html) && !/<button[^>]*data-toggle-thinking[^>]*disabled/.test(html);

  assert.equal(toggleIsEnabled, true);
});

test("the transcript area tells a no-JavaScript reader it needs JavaScript, without hiding the raw-file link", () => {
  const html = pageWithOneReviewCarrying({ transcript: transcript(), rawTranscriptHref: "run-a/transcripts/x.jsonl" });
  const noscriptMatch = /<noscript>([\s\S]*?)<\/noscript>/.exec(html);

  assert.deepEqual(
    { hasNoscript: noscriptMatch !== null, mentionsJavaScript: (noscriptMatch?.[1] ?? "").toLowerCase().includes("javascript") },
    { hasNoscript: true, mentionsJavaScript: true },
  );
});

function viewSectionsOfKind(html: string, kind: string): string[] {
  const markers = [...html.matchAll(/data-view="([^"]+)"/g)];
  return markers
    .map((marker, index) => ({
      kind: marker[1]!,
      content: html.slice(marker.index!, index + 1 < markers.length ? markers[index + 1]!.index! : html.length),
    }))
    .filter((section) => section.kind === kind)
    .map((section) => section.content);
}

test("the page renders each of the four views once a repetition carries a review and a transcript", () => {
  const detail = experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ transcript: transcript() }) })] })] });
  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  assert.deepEqual(
    ["experiments", "experiment", "review", "transcript"].map((kind) => viewSectionsOfKind(html, kind).length),
    [1, 1, 1, 1],
  );
});

function repetitionsPanelToggle(html: string): string {
  const match = /<button[^>]*data-toggle-repetitions[^>]*>/.exec(html);
  assert.notEqual(match, null, "no repetitions disclosure control found");
  return match![0];
}

test("a treatment's repetitions sit behind a disclosure control that starts collapsed", () => {
  const html = renderReportHtml(viewModel({ experimentDetails: [experimentDetailView()] }));

  assert.equal(repetitionsPanelToggle(html).includes('aria-expanded="false"'), true);
});

function repetitionsTableOf(html: string): string {
  const start = html.indexOf('class="repetitions"');
  const end = html.indexOf("</table>", start);
  return html.slice(start, end);
}

test("a repetition's review is reached by a link, not inlined under its row", () => {
  const detail = experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ id: "run-a-case-a-t1-1" }) })] })] });
  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  assert.equal(repetitionsTableOf(html).includes("data-review="), false);
});

test("a repetition with a review offers links to its review view and its transcript view", () => {
  const detail = experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ id: "run-a-case-a-t1-1" }) })] })] });
  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  const row = repetitionsTableOf(html);
  assert.deepEqual(
    { linksToReview: row.includes('href="#view-review-run-a-case-a-t1-1"'), linksToTranscript: row.includes('href="#view-transcript-run-a-case-a-t1-1"') },
    { linksToReview: true, linksToTranscript: true },
  );
});

test("a review's breadcrumb links back to the experiments list and to its own experiment", () => {
  const detail = experimentDetailView({ id: "exp-1", treatments: [treatmentView({ repetitions: [repetitionView({ review: review() })] })] });
  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  const [reviewSection] = viewSectionsOfKind(html, "review");
  assert.deepEqual(
    { linksToExperiments: reviewSection!.includes('href="#view-experiments"'), linksToExperiment: reviewSection!.includes('href="#view-experiment-exp-1"') },
    { linksToExperiments: true, linksToExperiment: true },
  );
});

test("a transcript view links back to its review", () => {
  const detail = experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ id: "run-a-case-a-t1-1" }) })] })] });
  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  const [transcriptSection] = viewSectionsOfKind(html, "transcript");
  assert.equal(transcriptSection!.includes('href="#view-review-run-a-case-a-t1-1"'), true);
});

test("a review no longer embeds the transcript viewer inline; the transcript view carries it instead", () => {
  const detail = experimentDetailView({ treatments: [treatmentView({ repetitions: [repetitionView({ review: review({ id: "r1", transcript: transcript() }) })] })] });
  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  const opening = html.indexOf('data-review="r1"');
  const closing = html.indexOf("</section>", opening);
  assert.equal(html.slice(opening, closing).includes("open transcript"), false);
});

test("a review view offers a link to the previous and next repetition, honoring the treatment's own order and its ends", () => {
  const repetitions = [
    repetitionView({ id: "run-a-case-a-t1-1", repetition: 1, review: review({ id: "run-a-case-a-t1-1" }) }),
    repetitionView({ id: "run-a-case-a-t1-2", repetition: 2, review: review({ id: "run-a-case-a-t1-2" }) }),
  ];
  const detail = experimentDetailView({ treatments: [treatmentView({ repetitions })] });
  const html = renderReportHtml(viewModel({ experimentDetails: [detail] }));

  const [firstReview, secondReview] = viewSectionsOfKind(html, "review");
  assert.deepEqual(
    {
      firstPreviousIsDisabled: firstReview!.includes('aria-disabled="true">‹ previous repetition<'),
      firstLinksNext: firstReview!.includes('href="#view-review-run-a-case-a-t1-2"'),
      secondLinksPrevious: secondReview!.includes('href="#view-review-run-a-case-a-t1-1"'),
      secondNextIsDisabled: secondReview!.includes('aria-disabled="true">next repetition ›<'),
    },
    { firstPreviousIsDisabled: true, firstLinksNext: true, secondLinksPrevious: true, secondNextIsDisabled: true },
  );
});

test("a no-JavaScript reader is told view navigation needs JavaScript", () => {
  const html = renderReportHtml(viewModel({}));

  const noscriptMatch = /<noscript>([\s\S]*?)<\/noscript>/.exec(html);
  assert.equal((noscriptMatch?.[1] ?? "").toLowerCase().includes("javascript"), true);
});
