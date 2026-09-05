import type {
  CodeStateName,
  CodeStateView,
  ExperimentDetailView,
  ExperimentView,
  MilestoneView,
  PerCaseCellView,
  PerCaseRowView,
  RepetitionView,
  ReportViewModel,
  ReviewStateCardView,
  ReviewView,
  SetupCheckView,
  TreatmentView,
  VerdictBarSegmentView,
} from "./report-view.ts";
import type { TranscriptView } from "./session-log.ts";
import { contextDiff } from "./diff-counts.ts";
import type { ContextDiffLine } from "./diff-counts.ts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeScriptClose(json: string): string {
  return json.replace(/<\/script/gi, "<\\/script");
}

const PAGE_STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 32px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1a1a; background: #fff; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  h2 { font-size: 15px; color: #555; font-weight: normal; margin: 24px 0 8px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ddd; vertical-align: top; font-size: 14px; }
  th { color: #555; font-weight: normal; }
  .kind { color: #555; font-size: 13px; }
  .chip { display: inline-block; padding: 1px 8px; margin-right: 4px; border: 1px solid #888; border-radius: 10px; font-size: 12px; }
  .unclaimed { margin-top: 16px; font-size: 14px; color: #555; }
  .unclaimed span { font-family: ui-monospace, Menlo, Consolas, monospace; margin-right: 8px; }
  .mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
  .chip.flag { border-color: #b3261e; color: #b3261e; }
  .experiment-detail { margin-top: 32px; padding-top: 16px; border-top: 2px solid #ddd; }
  .crumb { font-size: 13px; color: #777; margin-bottom: 8px; }
  .crumb a { color: #777; }
  .outcome-box { border: 1px solid #ddd; border-radius: 4px; padding: 8px 12px; margin: 8px 0 16px; font-size: 14px; max-width: 480px; }
  .setup-check { margin: 8px 0 16px; font-size: 13px; color: #555; }
  .filter-bar { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: #555; margin: 10px 0 4px; }
  .filter-bar button { font: inherit; padding: 2px 10px; margin-left: 4px; border: 1px solid #888; border-radius: 10px; background: #fff; cursor: pointer; }
  .filter-bar button.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  table.repetitions, table.per-case { margin-top: 4px; }
  table.repetitions tbody tr[data-repetition] { cursor: pointer; }
  table.repetitions tbody tr[data-repetition]:hover { background: #f7f7f5; }
  .detail { font-size: 12.5px; color: #555; }
  .review { border: 1px solid #ddd; border-radius: 4px; padding: 10px 14px; margin: 6px 0 14px; }
  .review h4 { margin: 0 0 8px; font-size: 13px; font-weight: normal; color: #555; }
  .why-box { border: 1px solid #ddd; border-radius: 4px; padding: 8px 12px; margin: 8px 0; }
  .why-box .label, .note-box .label, .state-col .label { font-size: 12.5px; color: #777; }
  .states { display: flex; gap: 0; border: 1px solid #ddd; border-radius: 4px; margin: 8px 0; }
  .state-col { flex: 1; padding: 8px 12px; border-right: 1px solid #ddd; overflow: auto; }
  .state-col:last-child { border-right: none; }
  .state-col .metric { margin-top: 2px; }
  .state-col .task-text { margin-top: 6px; color: #555; }
  .review-header { margin: 2px 0 8px; }
  .review-header .stats, .review-header .nudge-summary { font-size: 12.5px; color: #555; margin-top: 2px; }
  .code-text { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; margin: 4px 0 0; }
  .bar { display: inline-flex; height: 12px; width: 120px; border: 1px solid #888; overflow: hidden; vertical-align: middle; margin-right: 8px; }
  .bar div { height: 100%; }
  .bar .g { background: #1a1a1a; }
  .bar .m { background: #999; }
  .bar .x { background: repeating-linear-gradient(45deg, #fff 0 3px, #999 3px 5px); }
  .bar .w { background: #fff; }
  .compare-controls { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 13px; color: #555; margin: 8px 0; }
  .compare-controls button { font: inherit; padding: 2px 10px; border: 1px solid #888; border-radius: 10px; background: #fff; cursor: pointer; }
  .compare-controls button.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .diff-grid { display: flex; gap: 0; border: 1px solid #ddd; border-radius: 4px; margin: 8px 0; }
  .diff-col { flex: 1; padding: 8px 12px; border-right: 1px solid #ddd; overflow: auto; }
  .diff-col:last-child { border-right: none; }
  .diff-col .code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; white-space: pre; }
  .diff-col .code div { min-height: 1.4em; }
  .diff-col .code .del { background: #fbe9e7; text-decoration: line-through; color: #8a6b66; }
  .diff-col .code .add { background: #e6f4ea; color: #1e4620; }
  .diff-col .code .skip { color: #999; font-style: italic; }
  .note-box { border: 1px dashed #bbb; border-radius: 4px; padding: 8px 12px; margin: 8px 0; }
  .note-box textarea { width: 100%; font: inherit; margin-top: 6px; resize: vertical; }
  .note-box ul.note-list { margin: 4px 0; padding-left: 18px; font-size: 13px; }
  .transcript-block { border: 1px solid #ddd; border-radius: 4px; padding: 10px 14px; margin: 8px 0; }
  .transcript-block button { font: inherit; padding: 2px 10px; border: 1px solid #888; border-radius: 10px; background: #fff; cursor: pointer; }
  .transcript-block button[disabled] { color: #999; cursor: default; }
  .transcript-block button.active { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .transcript-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .transcript-viewer { margin-top: 10px; }
  .t-layout { display: grid; grid-template-columns: 1fr 240px; gap: 14px; align-items: start; }
  .t-turns { display: flex; flex-direction: column; gap: 8px; }
  .t-turn { border: 1px solid #ddd; border-radius: 4px; padding: 8px 12px; }
  .t-nudge { border: 1px dashed #999; border-radius: 4px; padding: 6px 12px; background: #f6f6f4; margin: 2px 0; }
  .t-retry { border: 1px dashed #bbb; border-radius: 4px; padding: 6px 12px; text-align: center; font-size: 12.5px; }
  .t-tool { margin-top: 4px; }
  .t-tool summary { cursor: pointer; }
  .t-tool[data-tool-error="1"] summary { color: #b3261e; }
  .t-code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; margin: 4px 0 0; }
  .t-thinking { margin-top: 4px; white-space: pre-wrap; }
  .t-panel { border: 1px solid #ddd; border-radius: 4px; padding: 8px 12px; }
  .no-js-note { font-size: 13px; color: #555; margin-top: 6px; }
  .top-no-js-note { font-size: 13px; color: #555; margin: 0 0 16px; }
  .btn { display: inline-block; padding: 2px 10px; margin-right: 6px; border: 1px solid #888; border-radius: 10px; background: #fff; color: #1a1a1a; text-decoration: none; font-size: 13px; }
  .btn[aria-disabled="true"] { color: #999; }
  .review-toolbar { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .disclosure { font: inherit; border: none; background: none; cursor: pointer; padding: 0; }
  .repetitions-panel { margin-top: 6px; }
  .js-nav [data-view] { display: none; }
  .js-nav [data-view].current { display: block; }
  .js-nav .repetitions-panel:not(.expanded) { display: none; }
`;

function renderTreatments(treatmentIds: string[]): string {
  return treatmentIds.map((id) => `<span class="chip">${escapeHtml(id)}</span>`).join(" ");
}

function renderIdenticalTreatmentsFlag(flagged: boolean): string {
  return flagged ? ' <span class="chip flag">identical treatments</span>' : "";
}

function renderExperimentRow(experiment: ExperimentView): string {
  return `<tr data-experiment="${escapeHtml(experiment.id)}">
      <td><a href="${hrefFor(experimentViewId(experiment.id))}"><b>${escapeHtml(experiment.name)}</b></a><br><span class="kind">${escapeHtml(experiment.kindLabel)}</span></td>
      <td>${escapeHtml(experiment.question)}</td>
      <td>${renderTreatments(experiment.treatmentIds)}</td>
      <td>${escapeHtml(experiment.model)}<br>${escapeHtml(experiment.tierLabel)}</td>
      <td>${escapeHtml(experiment.size)}</td>
      <td><span class="chip">${escapeHtml(experiment.status)}</span> ${escapeHtml(experiment.outcome)}${renderIdenticalTreatmentsFlag(experiment.identicalTreatmentsFlag)}</td>
    </tr>`;
}

function renderMilestone(milestone: MilestoneView): string {
  return `<h2>milestone · ${escapeHtml(milestone.milestone)}</h2>
  <table>
    <thead><tr><th>experiment</th><th>question</th><th>treatments</th><th>model · difficulty</th><th>size</th><th>outcome</th></tr></thead>
    <tbody>${milestone.experiments.map(renderExperimentRow).join("")}</tbody>
  </table>`;
}

function renderUnclaimed(runFolders: string[]): string {
  if (runFolders.length === 0) return "";
  const items = runFolders.map((run) => `<span data-unclaimed-run="${escapeHtml(run)}">${escapeHtml(run)}</span>`).join("");
  return `<div class="unclaimed">run folders no experiment claims: ${items}</div>`;
}

function renderSetupCheck(setupCheck: SetupCheckView): string {
  return `<div class="setup-check">setup check: ${escapeHtml(setupCheck.summary)}${renderIdenticalTreatmentsFlag(setupCheck.identicalTreatments)}</div>`;
}

function slug(key: string): string {
  return key.replace(/[^a-zA-Z0-9-]+/g, "-");
}

const EXPERIMENTS_VIEW_ID = "view-experiments";

function experimentViewId(experimentId: string): string {
  return `view-experiment-${slug(experimentId)}`;
}

function reviewViewId(reviewId: string): string {
  return `view-review-${slug(reviewId)}`;
}

function transcriptViewId(reviewId: string): string {
  return `view-transcript-${slug(reviewId)}`;
}

function hrefFor(viewId: string): string {
  return `#${viewId}`;
}

function experimentCrumbLabel(detail: ExperimentDetailView): string {
  return [detail.name, detail.tierLabel, detail.kindLabel].filter((part) => part.length > 0).join(" · ");
}

function crumbLink(viewId: string, label: string): string {
  return `<a href="${hrefFor(viewId)}">${escapeHtml(label)}</a>`;
}

function crumbCurrent(label: string): string {
  return `<b>${escapeHtml(label)}</b>`;
}

function repetitionCrumbLabel(repetition: RepetitionView): string {
  return `${repetition.caseId} · repetition ${repetition.repetition}`;
}

function experimentsAndOwnExperimentCrumb(detail: ExperimentDetailView): string {
  return `${crumbLink(EXPERIMENTS_VIEW_ID, "Experiments")} <span>›</span> ${crumbLink(experimentViewId(detail.id), experimentCrumbLabel(detail))} <span>›</span>`;
}

function reviewCrumb(detail: ExperimentDetailView, treatment: TreatmentView, repetition: RepetitionView): string {
  return `<div class="crumb">
    ${experimentsAndOwnExperimentCrumb(detail)}
    <span>${escapeHtml(treatment.treatmentId)}</span> <span>›</span>
    ${crumbCurrent(repetitionCrumbLabel(repetition))}
  </div>`;
}

function transcriptCrumb(detail: ExperimentDetailView, treatment: TreatmentView, repetition: RepetitionView): string {
  return `<div class="crumb">
    ${experimentsAndOwnExperimentCrumb(detail)}
    <span>${escapeHtml(treatment.treatmentId)}</span> <span>›</span>
    ${crumbLink(reviewViewId(repetition.review!.id), repetitionCrumbLabel(repetition))} <span>›</span>
    ${crumbCurrent("transcript")}
  </div>`;
}

function stateByName(states: CodeStateView[], name: CodeStateName): CodeStateView | undefined {
  return states.find((state) => state.name === name);
}

function verdictChipClass(verdict: string): string {
  return SEVERE_VERDICTS.has(verdict) ? "chip flag" : "chip";
}

const SEVERE_VERDICTS = new Set(["broken", "behavior-broken", "gamed", "bar-missed", "regressed", "extension-failed"]);

function stateLabelFor(review: ReviewView, name: CodeStateName): string {
  return stateByName(review.codeStates, name)?.label ?? name;
}

function stateTextAnchorId(dedupeKey: string): string {
  return `state-${slug(dedupeKey)}`;
}

function renderStateCard(card: ReviewStateCardView, label: string): string {
  const fileLine = card.fileAtCommit === undefined ? "" : `<div class="mono">${escapeHtml(card.fileAtCommit)}</div>`;
  const metricLine =
    card.metricLine === undefined
      ? ""
      : `<div class="metric">${card.verdict === undefined ? "" : `<span class="${verdictChipClass(card.verdict)}">${escapeHtml(card.verdict)}</span> `}<span class="mono kind">${escapeHtml(card.metricLine)}</span></div>`;
  const taskLine = card.taskText === undefined ? "" : `<div class="mono task-text">${escapeHtml(card.taskText)}</div>`;

  return `<div class="state-col" data-code-state="${escapeHtml(card.name)}" data-state-key="${escapeHtml(stateTextAnchorId(card.dedupeKey))}" data-state-label="${escapeHtml(label)}">
      <div class="kind">${escapeHtml(card.title)}</div>
      ${fileLine}
      ${metricLine}
      ${taskLine}
    </div>`;
}

function renderStates(review: ReviewView): string {
  return `<div class="states">${review.stateCards.map((card) => renderStateCard(card, stateLabelFor(review, card.name))).join("")}</div>`;
}

function collectStateTexts(review: ReviewView, seenStateKeys: Set<string>, collector: ViewCollector): void {
  for (const state of review.codeStates) {
    if (seenStateKeys.has(state.dedupeKey)) continue;
    seenStateKeys.add(state.dedupeKey);
    collector.stateTexts.push(`<pre hidden id="${stateTextAnchorId(state.dedupeKey)}" class="code-text">${escapeHtml(state.text)}</pre>`);
  }
}

function renderWhyBox(review: ReviewView): string {
  return `<div class="why-box"><div class="label">why this verdict</div><div>${escapeHtml(review.whyThisVerdict)}</div></div>`;
}

const DIFF_CONTEXT_LINES = 3;

function renderUnifiedSegment(segment: ContextDiffLine): string {
  if (segment.op === "skip") {
    return `<div class="skip">… ${segment.count} unchanged line${segment.count === 1 ? "" : "s"} …</div>`;
  }
  const cls = segment.op === "same" ? "" : ` class="${segment.op}"`;
  const prefix = segment.op === "add" ? "+ " : segment.op === "del" ? "- " : "  ";
  return `<div${cls}>${prefix}${escapeHtml(segment.text)}</div>`;
}

function renderDefaultDiff(review: ReviewView): string {
  const before = stateByName(review.codeStates, review.defaultBeforeName);
  const after = stateByName(review.codeStates, review.defaultAfterName);
  if (before === undefined || after === undefined) return "";

  const segments = contextDiff(before.text, after.text, DIFF_CONTEXT_LINES);
  const lines = segments.map(renderUnifiedSegment).join("");

  return `<div class="diff-grid" data-diff-view="unified"><div class="diff-col"><div class="mono kind">${escapeHtml(before.label)} → ${escapeHtml(after.label)}</div><div class="code">${lines}</div></div></div>`;
}

function comparePairs(names: CodeStateName[]): [CodeStateName, CodeStateName][] {
  const pairs: [CodeStateName, CodeStateName][] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) pairs.push([names[i]!, names[j]!]);
  }
  return pairs;
}

function renderPairButton(review: ReviewView, before: CodeStateName, after: CodeStateName): string {
  const active = before === review.defaultBeforeName && after === review.defaultAfterName;
  const beforeLabel = stateByName(review.codeStates, before)?.label ?? before;
  const afterLabel = stateByName(review.codeStates, after)?.label ?? after;
  return `<button type="button" class="${active ? "active" : ""}" data-pair-before="${escapeHtml(before)}" data-pair-after="${escapeHtml(after)}">${escapeHtml(beforeLabel)} → ${escapeHtml(afterLabel)}</button>`;
}

function renderReferenceToggle(review: ReviewView): string {
  const hasReference = review.reference !== undefined;
  return `<span class="kind">against</span>
    <button type="button" class="active" data-before-source="own">before</button>
    <button type="button" data-before-source="reference"${hasReference ? "" : " disabled"}>reference fix</button>`;
}

function renderFilesLine(review: ReviewView): string {
  return review.filesLine.length === 0 ? "" : `<span class="kind mono" style="margin-left: auto;">${escapeHtml(review.filesLine)}</span>`;
}

function renderCompareControls(review: ReviewView): string {
  const names = review.codeStates.map((state) => state.name);
  const pairButtons = comparePairs(names)
    .map(([before, after]) => renderPairButton(review, before, after))
    .join("");

  return `<div class="compare-controls">
    <span class="kind">compare</span>${pairButtons}
    ${renderReferenceToggle(review)}
    <span class="kind">view</span>
    <button type="button" data-view-mode="side-by-side">side by side</button>
    <button type="button" class="active" data-view-mode="unified">unified</button>
    ${renderFilesLine(review)}
  </div>`;
}

function renderNoteList(notes: string[]): string {
  if (notes.length === 0) return "";
  return `<ul class="note-list" data-note-list>${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`;
}

function renderLiveNoteBox(review: ReviewView): string {
  return `<div class="note-box" data-note-box="${escapeHtml(review.id)}">
    <div class="label">note</div>
    ${renderNoteList(review.notes)}
    <textarea placeholder="agree or disagree with the automatic verdict, one line"></textarea>
    <button type="button" data-save-note>save</button>
  </div>`;
}

function renderStaticNoteBox(review: ReviewView): string {
  return `<div class="note-box">
    <div class="label">note · saved once the report runs in serve mode</div>
    ${renderNoteList(review.notes)}
    <textarea disabled placeholder="agree or disagree with the automatic verdict, one line"></textarea>
    <button type="button" disabled>save</button>
  </div>`;
}

function renderNoteBox(review: ReviewView): string {
  return review.live ? renderLiveNoteBox(review) : renderStaticNoteBox(review);
}

function renderReferenceState(review: ReviewView, seenStateKeys: Set<string>): string {
  if (review.reference === undefined) return "";
  const anchorId = `state-${slug(review.reference.dedupeKey)}`;
  const isOwner = !seenStateKeys.has(review.reference.dedupeKey);
  if (isOwner) seenStateKeys.add(review.reference.dedupeKey);
  if (!isOwner) return "";
  return `<pre hidden id="${anchorId}" data-reference-state="${escapeHtml(review.reference.dedupeKey)}" class="code-text">${escapeHtml(review.reference.text)}</pre>`;
}

function renderThinkingToggle(reasoningPresent: boolean): string {
  if (!reasoningPresent) {
    return `<button type="button" disabled>thinking</button><span class="kind mono">not recorded</span>`;
  }
  return `<button type="button" data-toggle-thinking>thinking</button>`;
}

function renderTranscriptBlock(review: ReviewView): string {
  const rawLink = review.rawTranscriptHref === undefined ? "" : `<a class="mono kind" href="${escapeHtml(review.rawTranscriptHref)}">raw transcript file</a>`;

  if (review.transcript === undefined) {
    return `<div class="transcript-block">
      <div class="transcript-toolbar"><span class="kind">no transcript recorded for this repetition</span>${rawLink}</div>
    </div>`;
  }

  return `<div class="transcript-block" data-transcript-block="${escapeHtml(review.id)}">
    <div class="transcript-toolbar">
      ${renderThinkingToggle(review.transcript.reasoningPresent)}
      ${rawLink}
    </div>
    <noscript><div class="no-js-note">the transcript needs JavaScript to render here; use the raw transcript file link above.</div></noscript>
    <div class="transcript-viewer"></div>
  </div>`;
}

function renderReviewHeader(review: ReviewView): string {
  const nudgeLine = review.nudgeSummary.length === 0 ? "" : `<div class="nudge-summary mono">${escapeHtml(review.nudgeSummary)}</div>`;
  return `<div class="review-header">
    <h4><span class="${verdictChipClass(review.verdict)}">${escapeHtml(review.verdict)}</span></h4>
    <div class="stats mono">${escapeHtml(review.statsLine)}</div>
    ${nudgeLine}
  </div>`;
}

function renderReview(review: ReviewView, seenStateKeys: Set<string>, collector: ViewCollector): string {
  collectStateTexts(review, seenStateKeys, collector);

  return `<section data-review="${escapeHtml(review.id)}" class="review">
    ${renderReviewHeader(review)}
    ${renderStates(review)}
    ${renderCompareControls(review)}
    <div class="diff-holder">${renderDefaultDiff(review)}</div>
    ${renderWhyBox(review)}
    ${renderReferenceState(review, seenStateKeys)}
    ${renderNoteBox(review)}
  </section>`;
}

interface RepetitionNeighbors {
  previous: RepetitionView | undefined;
  next: RepetitionView | undefined;
}

function neighborsOf(repetitions: RepetitionView[], index: number): RepetitionNeighbors {
  return { previous: repetitions[index - 1], next: repetitions[index + 1] };
}

function prevNextLink(neighbor: RepetitionView | undefined, label: string): string {
  if (neighbor?.review === undefined) return `<span class="btn" aria-disabled="true">${escapeHtml(label)}</span>`;
  return `<a class="btn" href="${hrefFor(reviewViewId(neighbor.review.id))}">${escapeHtml(label)}</a>`;
}

function renderReviewView(
  detail: ExperimentDetailView,
  treatment: TreatmentView,
  repetition: RepetitionView,
  review: ReviewView,
  neighbors: RepetitionNeighbors,
  seenStateKeys: Set<string>,
  collector: ViewCollector,
): string {
  return `<section data-view="review" id="${reviewViewId(review.id)}">
    ${reviewCrumb(detail, treatment, repetition)}
    <div class="review-toolbar">
      ${prevNextLink(neighbors.previous, "‹ previous repetition")}
      ${prevNextLink(neighbors.next, "next repetition ›")}
      <a class="btn" href="${hrefFor(transcriptViewId(review.id))}">transcript</a>
    </div>
    ${renderReview(review, seenStateKeys, collector)}
  </section>`;
}

function renderTranscriptView(detail: ExperimentDetailView, treatment: TreatmentView, repetition: RepetitionView, review: ReviewView): string {
  return `<section data-view="transcript" id="${transcriptViewId(review.id)}">
    ${transcriptCrumb(detail, treatment, repetition)}
    <div class="review-toolbar"><a class="btn" href="${hrefFor(reviewViewId(review.id))}">‹ review</a></div>
    ${renderTranscriptBlock(review)}
  </section>`;
}

interface ViewCollector {
  reviewViews: string[];
  transcriptViews: string[];
  stateTexts: string[];
}

function caseCellFor(repetition: RepetitionView): string {
  const label = `${escapeHtml(repetition.caseId)} · ${repetition.repetition}`;
  return repetition.review === undefined ? label : `<a href="${hrefFor(reviewViewId(repetition.review.id))}">${label}</a>`;
}

function transcriptLink(review: ReviewView | undefined): string {
  return review === undefined ? "" : ` · <a href="${hrefFor(transcriptViewId(review.id))}">transcript</a>`;
}

function renderRepetitionRow(
  detail: ExperimentDetailView,
  treatment: TreatmentView,
  repetition: RepetitionView,
  index: number,
  seenStateKeys: Set<string>,
  collector: ViewCollector,
): string {
  const successful = repetition.verdict === detail.successVerdict ? "1" : "0";
  const nudged = repetition.nudged ? "1" : "0";
  const control = treatment.treatmentId === detail.controlTreatmentId ? "1" : "0";

  if (repetition.review !== undefined) {
    const neighbors = neighborsOf(treatment.repetitions, index);
    collector.reviewViews.push(renderReviewView(detail, treatment, repetition, repetition.review, neighbors, seenStateKeys, collector));
    collector.transcriptViews.push(renderTranscriptView(detail, treatment, repetition, repetition.review));
  }

  return `<tr data-repetition="${escapeHtml(repetition.id)}" data-successful="${successful}" data-nudged="${nudged}" data-control="${control}">
      <td class="mono">${caseCellFor(repetition)}</td>
      <td><span class="chip">${escapeHtml(repetition.verdict)}</span></td>
      <td>${escapeHtml(repetition.startsFromLabel)}</td>
      <td class="mono">${escapeHtml(repetition.linesAddedRemoved)}</td>
      <td class="mono">${escapeHtml(repetition.turns)}</td>
      <td class="mono">${escapeHtml(repetition.tokensIn)}</td>
      <td class="mono">${escapeHtml(repetition.nudges)}</td>
      <td class="detail">${escapeHtml(repetition.detail)}${transcriptLink(repetition.review)}</td>
    </tr>`;
}

const REPETITION_FILTERS: readonly { filter: string; label: string }[] = [
  { filter: "all", label: "all" },
  { filter: "not-successful", label: "not successful" },
  { filter: "nudged", label: "nudged" },
  { filter: "controls", label: "controls" },
];

function renderFilterBar(repetitionCount: number): string {
  const buttons = REPETITION_FILTERS.map(
    ({ filter, label }) => `<button type="button" data-filter="${filter}"${filter === "all" ? ' class="active"' : ""}>${label}</button>`,
  ).join("");
  return `<div class="filter-bar"><span>${repetitionCount} repetitions, worst first</span><span class="filters">${buttons}</span></div>`;
}

function renderTreatmentRow(detail: ExperimentDetailView, treatment: TreatmentView, seenStateKeys: Set<string>, collector: ViewCollector): string {
  const panelId = `repetitions-${slug(treatment.run)}-${slug(treatment.treatmentId)}`;
  const rows = treatment.repetitions
    .map((repetition, index) => renderRepetitionRow(detail, treatment, repetition, index, seenStateKeys, collector))
    .join("");

  return `<tr>
      <td>
        <button type="button" class="disclosure" data-toggle-repetitions aria-expanded="false" aria-controls="${panelId}">▸</button>
      </td>
      <td><b>${escapeHtml(treatment.treatmentId)}</b><br><span class="kind mono">run folder ${escapeHtml(treatment.run)}</span></td>
      <td>${renderBar(treatment.verdictBarSegments)}<span class="mono kind">${escapeHtml(treatment.verdictDistribution)}</span></td>
      <td class="mono">${escapeHtml(treatment.meanTurns)}</td>
      <td class="mono">${escapeHtml(treatment.meanTokensIn)}</td>
      <td class="mono">${escapeHtml(treatment.meanNudgesPerRepetition)}</td>
    </tr>
    <tr>
      <td colspan="6">
        <div id="${panelId}" class="repetitions-panel">
          ${renderFilterBar(treatment.repetitions.length)}
          <table class="repetitions">
            <thead><tr><th>case · repetition</th><th>verdict</th><th>starts from</th><th>lines added / removed</th><th>turns</th><th>input tokens</th><th>nudges</th><th>detail</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </td>
    </tr>`;
}

function renderTreatmentsTable(detail: ExperimentDetailView, seenStateKeys: Set<string>, collector: ViewCollector): string {
  return `<table class="treatments">
    <thead><tr><th style="width: 24px;"></th><th>treatment</th><th>verdicts</th><th>mean turns</th><th>mean input tokens</th><th>mean nudges/repetition</th></tr></thead>
    <tbody>${detail.treatments.map((treatment) => renderTreatmentRow(detail, treatment, seenStateKeys, collector)).join("")}</tbody>
  </table>`;
}

function renderBar(segments: VerdictBarSegmentView[]): string {
  if (segments.length === 0) return "";
  const parts = segments.map((segment) => `<div class="${segment.cls}" style="width: ${segment.pct}%;"></div>`).join("");
  return `<div class="bar">${parts}</div>`;
}

function renderPerCaseCell(cell: PerCaseCellView): string {
  return `<td>${renderBar(cell.barSegments)}<span class="mono kind">${escapeHtml(cell.label)}</span></td>`;
}

function renderPerCaseRow(row: PerCaseRowView): string {
  const cells = row.cells.map(renderPerCaseCell).join("");
  return `<tr><td class="mono">${escapeHtml(row.caseId)}</td>${cells}<td>${escapeHtml(row.wherePart)}</td></tr>`;
}

function renderPerCaseTable(detail: ExperimentDetailView): string {
  if (detail.perCase.length === 0) return "";
  const treatmentHeaders = detail.treatmentIds.map((treatmentId) => `<th>${escapeHtml(treatmentId)}</th>`).join("");
  return `<h3>Per case</h3>
  <table class="per-case">
    <thead><tr><th>case</th>${treatmentHeaders}<th>where they part</th></tr></thead>
    <tbody>${detail.perCase.map(renderPerCaseRow).join("")}</tbody>
  </table>`;
}

function renderExperimentDetail(detail: ExperimentDetailView, seenStateKeys: Set<string>, collector: ViewCollector): string {
  return `<section data-view="experiment" id="${experimentViewId(detail.id)}" class="experiment-detail">
    <div class="crumb">${crumbLink(EXPERIMENTS_VIEW_ID, "Experiments")} <span>›</span> ${crumbCurrent(experimentCrumbLabel(detail))}</div>
    <h2>${escapeHtml(detail.name)} <span class="kind">· ${escapeHtml(detail.kindLabel)}</span></h2>
    <p>${escapeHtml(detail.question)}</p>
    <div class="outcome-box"><span class="kind">outcome</span><br>${escapeHtml(detail.outcome)}</div>
    ${renderSetupCheck(detail.setupCheck)}
    <h3>Treatments</h3>
    ${renderTreatmentsTable(detail, seenStateKeys, collector)}
    ${renderPerCaseTable(detail)}
  </section>`;
}

const FILTER_SCRIPT = `<script>
document.querySelectorAll(".filter-bar").forEach(function (bar) {
  var table = bar.nextElementSibling;
  var buttons = bar.querySelectorAll("button[data-filter]");
  buttons.forEach(function (button) {
    button.addEventListener("click", function () {
      buttons.forEach(function (b) { b.classList.remove("active"); });
      button.classList.add("active");
      var filter = button.dataset.filter;
      table.querySelectorAll("tr[data-repetition]").forEach(function (row) {
        row.hidden = !(
          filter === "all" ||
          (filter === "not-successful" && row.dataset.successful === "0") ||
          (filter === "nudged" && row.dataset.nudged === "1") ||
          (filter === "controls" && row.dataset.control === "1")
        );
      });
    });
  });
});
</script>`;

const DISCLOSURE_SCRIPT = `<script>
document.querySelectorAll("[data-toggle-repetitions]").forEach(function (button) {
  button.addEventListener("click", function () {
    var panel = document.getElementById(button.getAttribute("aria-controls"));
    var expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    panel.classList.toggle("expanded", !expanded);
    button.textContent = expanded ? "▸" : "▾";
  });
});
</script>`;

const ROW_CLICK_SCRIPT = `<script>
document.querySelectorAll("tr[data-repetition]").forEach(function (row) {
  row.addEventListener("click", function (event) {
    if (event.target.closest("a")) return;
    var link = row.querySelector("td a");
    if (link) location.hash = link.getAttribute("href").slice(1);
  });
});
</script>`;

const HIDE_VIEWS_BEFORE_PAINT_SCRIPT = `<script>document.documentElement.classList.add("js-nav");</script>`;

const ROUTER_SCRIPT = `<script>
(function () {
  function applyRoute() {
    var hash = location.hash.slice(1) || "${EXPERIMENTS_VIEW_ID}";
    var matched = false;
    document.querySelectorAll("[data-view]").forEach(function (section) {
      var current = section.id === hash;
      section.classList.toggle("current", current);
      if (current) matched = true;
    });
    if (!matched) document.getElementById("${EXPERIMENTS_VIEW_ID}").classList.add("current");
  }

  window.addEventListener("hashchange", applyRoute);
  applyRoute();
})();
</script>`;

const REVIEW_SCRIPT = `<script>
(function () {
  function splitLines(text) {
    if (text.length === 0) return [];
    var lines = text.split("\\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  function lcsTable(a, b) {
    var table = [];
    for (var i = 0; i <= a.length; i++) table.push(new Array(b.length + 1).fill(0));
    for (i = 1; i <= a.length; i++) {
      for (var j = 1; j <= b.length; j++) {
        table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
    return table;
  }

  function lineDiff(before, after) {
    var a = splitLines(before);
    var b = splitLines(after);
    var table = lcsTable(a, b);
    var ops = [];
    var i = a.length;
    var j = b.length;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        ops.push({ op: "same", text: a[i - 1] });
        i--;
        j--;
      } else if (table[i][j - 1] >= table[i - 1][j]) {
        ops.push({ op: "add", text: b[j - 1] });
        j--;
      } else {
        ops.push({ op: "del", text: a[i - 1] });
        i--;
      }
    }
    while (i > 0) {
      ops.push({ op: "del", text: a[i - 1] });
      i--;
    }
    while (j > 0) {
      ops.push({ op: "add", text: b[j - 1] });
      j--;
    }
    ops.reverse();
    return ops;
  }

  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function sideBySideHtml(beforeLabel, afterLabel, ops) {
    var beforeLines = [];
    var afterLines = [];
    ops.forEach(function (op) {
      if (op.op === "same") {
        beforeLines.push('<div>' + escapeHtml(op.text) + '</div>');
        afterLines.push('<div>' + escapeHtml(op.text) + '</div>');
      } else if (op.op === "del") {
        beforeLines.push('<div class="del">' + escapeHtml(op.text) + '</div>');
      } else {
        afterLines.push('<div class="add">' + escapeHtml(op.text) + '</div>');
      }
    });
    return '<div class="diff-grid">' +
      '<div class="diff-col"><div class="mono kind">' + escapeHtml(beforeLabel) + '</div><div class="code">' + beforeLines.join("") + '</div></div>' +
      '<div class="diff-col"><div class="mono kind">' + escapeHtml(afterLabel) + '</div><div class="code">' + afterLines.join("") + '</div></div>' +
      '</div>';
  }

  function unifiedHtml(beforeLabel, afterLabel, ops) {
    var lines = ops.map(function (op) {
      var cls = op.op === "same" ? "" : ' class="' + op.op + '"';
      var prefix = op.op === "add" ? "+ " : op.op === "del" ? "- " : "  ";
      return "<div" + cls + ">" + prefix + escapeHtml(op.text) + "</div>";
    }).join("");
    return '<div class="diff-grid"><div class="diff-col"><div class="mono kind">' + escapeHtml(beforeLabel) + ' → ' + escapeHtml(afterLabel) +
      '</div><div class="code">' + lines + '</div></div></div>';
  }

  function stateTextAndLabel(section, name) {
    var cols = section.querySelectorAll("[data-code-state]");
    var col = null;
    for (var k = 0; k < cols.length; k++) {
      if (cols[k].dataset.codeState === name) {
        col = cols[k];
        break;
      }
    }
    if (!col) return null;
    var label = col.dataset.stateLabel;
    var pre = document.getElementById(col.dataset.stateKey);
    return { text: pre ? pre.textContent : "", label: label };
  }

  function referenceTextFor(section) {
    var pre = section.querySelector("[data-reference-state]");
    return pre ? pre.textContent : "";
  }

  var VIEW_MODE_STORAGE_KEY = "liubai-eval-report:diff-view-mode";

  function storedViewMode() {
    try {
      return window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }

  function storeViewMode(mode) {
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch (err) {
      // no persistence available; the choice just won't survive navigation or reload
    }
  }

  document.querySelectorAll(".review").forEach(function (section) {
    var holder = section.querySelector(".diff-holder");
    var pairButtons = section.querySelectorAll("button[data-pair-before]");
    var sourceButtons = section.querySelectorAll("button[data-before-source]");
    var viewButtons = section.querySelectorAll("button[data-view-mode]");
    if (!holder || pairButtons.length === 0) return;

    var state = { before: null, after: null, useReference: false, view: "unified" };
    pairButtons.forEach(function (button) {
      if (button.classList.contains("active")) {
        state.before = button.dataset.pairBefore;
        state.after = button.dataset.pairAfter;
      }
    });
    viewButtons.forEach(function (button) {
      if (button.classList.contains("active")) state.view = button.dataset.viewMode;
    });

    var remembered = storedViewMode();
    if (remembered && remembered !== state.view) {
      state.view = remembered;
      viewButtons.forEach(function (button) {
        button.classList.toggle("active", button.dataset.viewMode === remembered);
      });
    }

    function render() {
      var beforeInfo = state.useReference ? { text: referenceTextFor(section), label: "case reference" } : stateTextAndLabel(section, state.before);
      var afterInfo = stateTextAndLabel(section, state.after);
      if (!beforeInfo || !afterInfo) return;
      var ops = lineDiff(beforeInfo.text, afterInfo.text);
      holder.innerHTML = state.view === "unified" ? unifiedHtml(beforeInfo.label, afterInfo.label, ops) : sideBySideHtml(beforeInfo.label, afterInfo.label, ops);
    }

    if (remembered && remembered !== "unified") render();

    pairButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        pairButtons.forEach(function (b) { b.classList.remove("active"); });
        button.classList.add("active");
        state.before = button.dataset.pairBefore;
        state.after = button.dataset.pairAfter;
        render();
      });
    });

    sourceButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.disabled) return;
        sourceButtons.forEach(function (b) { b.classList.remove("active"); });
        button.classList.add("active");
        state.useReference = button.dataset.beforeSource === "reference";
        render();
      });
    });

    viewButtons.forEach(function (button) {
      button.addEventListener("click", function () {
        viewButtons.forEach(function (b) { b.classList.remove("active"); });
        button.classList.add("active");
        state.view = button.dataset.viewMode;
        storeViewMode(state.view);
        render();
      });
    });
  });
})();
</script>`;

const NOTE_SCRIPT = `<script>
document.querySelectorAll("[data-note-box]").forEach(function (box) {
  var button = box.querySelector("[data-save-note]");
  var textarea = box.querySelector("textarea");
  var list = box.querySelector("[data-note-list]");
  if (!button || !textarea) return;

  button.addEventListener("click", function () {
    var text = textarea.value.trim();
    if (text.length === 0) return;

    fetch("/note", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repetition: box.dataset.noteBox, text: text }),
    }).then(function (response) {
      if (!response.ok) return;
      if (!list) {
        list = document.createElement("ul");
        list.className = "note-list";
        list.dataset.noteList = "";
        box.insertBefore(list, textarea);
      }
      var item = document.createElement("li");
      item.textContent = text;
      list.appendChild(item);
      textarea.value = "";
    });
  });
});
</script>`;

const TRANSCRIPT_SCRIPT = `<script>
(function () {
  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function turnHeader(turn) {
    if (turn.isRetryFailure) return "turn " + turn.number + " · provider error, retried";
    if (turn.userText !== null) return "turn " + turn.number + " · user";
    if (turn.toolCalls.length > 0) return "turn " + turn.number + " · assistant · tool call";
    if (turn.isFinal) return "turn " + turn.number + " · assistant · final";
    return "turn " + turn.number + " · assistant";
  }

  function toolCallHtml(call) {
    var summary = escapeHtml(call.name) + (call.summary ? " " + escapeHtml(call.summary) : "");
    var body = "";
    if (call.diff !== null) {
      body = '<pre class="t-code">' + escapeHtml(call.diff) + (call.diffTruncated ? "\\n… see the raw transcript file for the rest" : "") + "</pre>";
    } else if (call.result !== null) {
      body =
        '<div class="kind mono">result · ' + call.resultLineCount + " line" + (call.resultLineCount === 1 ? "" : "s") + "</div>" +
        '<pre class="t-code">' + escapeHtml(call.result) + (call.resultTruncated ? "\\n… see the raw transcript file for the rest" : "") + "</pre>";
    }
    return '<details class="t-tool"' + (call.isError ? ' data-tool-error="1"' : "") + '><summary class="mono">' + summary + "</summary>" + body + "</details>";
  }

  function turnBodyHtml(turn) {
    var parts = [];
    if (turn.userText !== null) parts.push("<div>" + escapeHtml(turn.userText) + "</div>");
    if (turn.assistantText !== null) parts.push("<div>" + escapeHtml(turn.assistantText) + "</div>");
    if (turn.thinking !== null) parts.push('<div class="t-thinking mono kind" hidden>' + escapeHtml(turn.thinking) + "</div>");
    turn.toolCallDetails.forEach(function (call) { parts.push(toolCallHtml(call)); });
    return parts.join("");
  }

  function nudgeHtml(turn, rule) {
    return '<div class="t-nudge"><div class="kind" style="font-size:12.5px;">turn ' + turn.number + " · rail nudge · " + escapeHtml(rule) + "</div></div>";
  }

  function turnHtml(turn) {
    var html = '<div class="t-turn" data-turn="' + turn.number + '"><div class="kind" style="font-size:13px;">' + escapeHtml(turnHeader(turn)) + "</div>" + turnBodyHtml(turn) + "</div>";
    turn.nudges.forEach(function (rule) { html += nudgeHtml(turn, rule); });
    return html;
  }

  function collapsedRetryHtml(count, resumingTurn) {
    return '<div class="t-retry kind">' + count + " automatic retr" + (count === 1 ? "y" : "ies") + " before turn " + resumingTurn + ", collapsed</div>";
  }

  function turnsHtml(turns) {
    var html = "";
    var i = 0;
    while (i < turns.length) {
      if (turns[i].isRetryFailure) {
        var start = i;
        while (i < turns.length && turns[i].isRetryFailure) i++;
        var resumingTurn = i < turns.length ? turns[i].number : turns[start].number;
        html += collapsedRetryHtml(i - start, resumingTurn);
        continue;
      }
      html += turnHtml(turns[i]);
      i++;
    }
    return html;
  }

  function tokensPanelHtml(turns) {
    var rows = turns.map(function (turn) {
      return turn.number + " · " + (turn.tokensIn === null ? "-" : turn.tokensIn) + " · " + (turn.tokensOut === null ? "-" : turn.tokensOut);
    });
    return '<div class="t-panel"><div class="kind" style="font-size:13px;">per turn · input · output tokens</div><div class="mono" style="font-size:12.5px; line-height:1.6;">' + rows.join("<br>") + "</div></div>";
  }

  function toolsPanelHtml(turns) {
    var counts = {};
    turns.forEach(function (turn) { turn.toolCalls.forEach(function (name) { counts[name] = (counts[name] || 0) + 1; }); });
    var names = Object.keys(counts).sort();
    var rows = names.map(function (name) { return escapeHtml(name) + " ×" + counts[name]; });
    return '<div class="t-panel"><div class="kind" style="font-size:13px;">tools used</div><div class="mono" style="font-size:12.5px; line-height:1.6;">' + (rows.length === 0 ? "none" : rows.join("<br>")) + "</div></div>";
  }

  function jumpPanelHtml(turns) {
    var firstEdit = null;
    var filesCreated = [];
    var seenPaths = {};
    var nudgeTurns = [];
    var finalTurn = null;

    turns.forEach(function (turn) {
      turn.toolCallDetails.forEach(function (call) {
        if (firstEdit === null && (call.name === "edit" || call.name === "write")) firstEdit = turn.number;
        if (call.name === "write") {
          var path = call.summary;
          if (path && !seenPaths[path]) {
            seenPaths[path] = true;
            filesCreated.push({ path: path, turn: turn.number });
          }
        }
      });
      if (turn.nudges.length > 0) nudgeTurns.push(turn.number);
      if (turn.isFinal) finalTurn = turn.number;
    });

    var lines = [];
    lines.push(firstEdit === null ? "first edit · none" : "first edit · turn " + firstEdit);
    lines.push(nudgeTurns.length === 0 ? "rail nudges · none" : "rail nudges · turns " + nudgeTurns.join(", "));
    filesCreated.forEach(function (file) {
      lines.push(escapeHtml(file.path.split("/").pop()) + " created · turn " + file.turn);
    });
    lines.push(finalTurn === null ? "final message · none" : "final message · turn " + finalTurn);

    return '<div class="t-panel"><div class="kind" style="font-size:13px;">jump to</div><div style="line-height:1.7;">' + lines.join("<br>") + "</div></div>";
  }

  function renderTranscript(container, transcript) {
    container.innerHTML =
      '<div class="t-layout"><div class="t-turns">' + turnsHtml(transcript.turns) + '</div><div class="t-side">' +
      tokensPanelHtml(transcript.turns) + toolsPanelHtml(transcript.turns) + jumpPanelHtml(transcript.turns) +
      "</div></div>";
  }

  document.querySelectorAll("[data-toggle-thinking]").forEach(function (toggle) {
    var shown = false;
    toggle.addEventListener("click", function () {
      shown = !shown;
      toggle.classList.toggle("active", shown);
      var block = toggle.closest(".transcript-block");
      block.querySelectorAll(".t-thinking").forEach(function (el) { el.hidden = !shown; });
    });
  });

  document.querySelectorAll("[data-transcript-block]").forEach(function (block) {
    var id = block.getAttribute("data-transcript-block");
    var viewer = block.querySelector(".transcript-viewer");
    var island = document.querySelector('script[data-transcript="' + id + '"]');
    if (!viewer || !island) return;
    var transcript = JSON.parse(island.textContent);
    renderTranscript(viewer, transcript);
  });
})();
</script>`;

interface TranscriptIsland {
  id: string;
  transcript: TranscriptView;
}

function collectTranscriptIslands(model: ReportViewModel): TranscriptIsland[] {
  const islands: TranscriptIsland[] = [];
  for (const detail of model.experimentDetails) {
    for (const treatment of detail.treatments) {
      for (const repetition of treatment.repetitions) {
        const transcript = repetition.review?.transcript;
        if (transcript !== undefined) islands.push({ id: repetition.review!.id, transcript });
      }
    }
  }
  return islands;
}

function renderTranscriptIslands(islands: TranscriptIsland[]): string {
  return islands
    .map((island) => `<script type="application/json" data-transcript="${escapeHtml(island.id)}">${escapeScriptClose(JSON.stringify(island.transcript))}</script>`)
    .join("");
}

function renderExperimentsView(model: ReportViewModel): string {
  return `<section data-view="experiments" id="${EXPERIMENTS_VIEW_ID}">
    <h1>Experiments</h1>
    ${model.milestones.map(renderMilestone).join("")}
    ${renderUnclaimed(model.unclaimedRunFolders)}
  </section>`;
}

export function renderReportHtml(model: ReportViewModel): string {
  const seenStateKeys = new Set<string>();
  const collector: ViewCollector = { reviewViews: [], transcriptViews: [], stateTexts: [] };
  const experimentSections = model.experimentDetails.map((detail) => renderExperimentDetail(detail, seenStateKeys, collector)).join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>liubai eval report</title>
<style>${PAGE_STYLE}</style>
${HIDE_VIEWS_BEFORE_PAINT_SCRIPT}
</head>
<body>
<noscript><div class="top-no-js-note">navigating between experiments, reviews and transcripts needs JavaScript; every section is shown below instead.</div></noscript>
${renderExperimentsView(model)}
${experimentSections}
${collector.reviewViews.join("")}
${collector.transcriptViews.join("")}
${collector.stateTexts.join("")}
${FILTER_SCRIPT}
${DISCLOSURE_SCRIPT}
${ROW_CLICK_SCRIPT}
${ROUTER_SCRIPT}
${REVIEW_SCRIPT}
${TRANSCRIPT_SCRIPT}
${NOTE_SCRIPT}
${renderTranscriptIslands(collectTranscriptIslands(model))}
</body>
</html>
`;
}
