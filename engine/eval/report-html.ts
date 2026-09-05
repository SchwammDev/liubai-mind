import type {
  CodeStateName,
  CodeStateView,
  ExperimentDetailView,
  ExperimentView,
  MilestoneView,
  PerCaseRowView,
  RepetitionView,
  ReportViewModel,
  ReviewView,
  SetupCheckView,
  TreatmentView,
} from "./report-view.ts";
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
  .detail { font-size: 12.5px; color: #555; }
  .review { border: 1px solid #ddd; border-radius: 4px; padding: 10px 14px; margin: 6px 0 14px; }
  .review h4 { margin: 0 0 8px; font-size: 13px; font-weight: normal; color: #555; }
  .why-box { border: 1px solid #ddd; border-radius: 4px; padding: 8px 12px; margin: 8px 0; }
  .why-box .label, .note-box .label, .state-col .label { font-size: 12.5px; color: #777; }
  .states { display: flex; gap: 0; border: 1px solid #ddd; border-radius: 4px; margin: 8px 0; }
  .state-col { flex: 1; padding: 8px 12px; border-right: 1px solid #ddd; overflow: auto; }
  .state-col:last-child { border-right: none; }
  .code-text { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; margin: 4px 0 0; }
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
`;

function renderTreatments(treatmentIds: string[]): string {
  return treatmentIds.map((id) => `<span class="chip">${escapeHtml(id)}</span>`).join(" ");
}

function renderIdenticalTreatmentsFlag(flagged: boolean): string {
  return flagged ? ' <span class="chip flag">identical treatments</span>' : "";
}

function renderExperimentRow(experiment: ExperimentView): string {
  return `<tr data-experiment="${escapeHtml(experiment.id)}">
      <td><a href="#experiment-${escapeHtml(experiment.id)}"><b>${escapeHtml(experiment.name)}</b></a><br><span class="kind">${escapeHtml(experiment.kindLabel)}</span></td>
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

function stateByName(states: CodeStateView[], name: CodeStateName): CodeStateView | undefined {
  return states.find((state) => state.name === name);
}

function renderCodeState(state: CodeStateView, seenStateKeys: Set<string>): string {
  const anchorId = `state-${slug(state.dedupeKey)}`;
  const isOwner = !seenStateKeys.has(state.dedupeKey);
  if (isOwner) seenStateKeys.add(state.dedupeKey);

  const body = isOwner
    ? `<pre id="${anchorId}" class="code-text">${escapeHtml(state.text)}</pre>`
    : `<a href="#${anchorId}" class="mono">same as shown above</a>`;

  return `<div class="state-col" data-code-state="${escapeHtml(state.name)}" data-state-key="${escapeHtml(state.dedupeKey)}">
      <div class="label">${escapeHtml(state.label)}</div>
      <div class="mono kind">${escapeHtml(state.caption)}</div>
      ${body}
    </div>`;
}

function renderStates(review: ReviewView, seenStateKeys: Set<string>): string {
  return `<div class="states">${review.codeStates.map((state) => renderCodeState(state, seenStateKeys)).join("")}</div>`;
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
  if (review.reference === undefined) return "";
  return `<span class="kind">against</span>
    <button type="button" class="active" data-before-source="own">before</button>
    <button type="button" data-before-source="reference">reference fix</button>`;
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
  </div>`;
}

function renderNoteBox(): string {
  return `<div class="note-box">
    <div class="label">note · saved once the report runs in serve mode</div>
    <textarea disabled placeholder="agree or disagree with the automatic verdict, one line"></textarea>
    <button type="button" disabled>save</button>
  </div>`;
}

function renderReferenceState(review: ReviewView, seenStateKeys: Set<string>): string {
  if (review.reference === undefined) return "";
  const anchorId = `state-${slug(review.reference.dedupeKey)}`;
  const isOwner = !seenStateKeys.has(review.reference.dedupeKey);
  if (isOwner) seenStateKeys.add(review.reference.dedupeKey);
  if (!isOwner) return "";
  return `<pre hidden id="${anchorId}" data-reference-state="${escapeHtml(review.reference.dedupeKey)}" class="code-text">${escapeHtml(review.reference.text)}</pre>`;
}

function renderReview(review: ReviewView, seenStateKeys: Set<string>): string {
  return `<section id="review-${slug(review.id)}" data-review="${escapeHtml(review.id)}" class="review">
    <h4><span class="chip">${escapeHtml(review.verdict)}</span></h4>
    ${renderStates(review, seenStateKeys)}
    ${renderCompareControls(review)}
    <div class="diff-holder">${renderDefaultDiff(review)}</div>
    ${renderWhyBox(review)}
    ${renderReferenceState(review, seenStateKeys)}
    ${renderNoteBox()}
  </section>`;
}

function renderReviewRow(review: ReviewView | undefined, seenStateKeys: Set<string>): string {
  if (review === undefined) return "";
  return `<tr><td colspan="8">${renderReview(review, seenStateKeys)}</td></tr>`;
}

function renderRepetitionRow(detail: ExperimentDetailView, treatmentId: string, repetition: RepetitionView, seenStateKeys: Set<string>): string {
  const successful = repetition.verdict === detail.successVerdict ? "1" : "0";
  const nudged = repetition.nudged ? "1" : "0";
  const control = treatmentId === detail.controlTreatmentId ? "1" : "0";
  const reviewLink = repetition.review === undefined ? "" : ` · <a href="#review-${slug(repetition.review.id)}">review</a>`;

  return `<tr data-repetition="${escapeHtml(repetition.id)}" data-successful="${successful}" data-nudged="${nudged}" data-control="${control}">
      <td class="mono">${escapeHtml(repetition.caseId)} · ${repetition.repetition}</td>
      <td><span class="chip">${escapeHtml(repetition.verdict)}</span></td>
      <td>${escapeHtml(repetition.startsFromLabel)}</td>
      <td class="mono">${escapeHtml(repetition.linesAddedRemoved)}</td>
      <td class="mono">${escapeHtml(repetition.turns)}</td>
      <td class="mono">${escapeHtml(repetition.tokensIn)}</td>
      <td class="mono">${escapeHtml(repetition.nudges)}</td>
      <td class="detail">${escapeHtml(repetition.detail)}${reviewLink}</td>
    </tr>${renderReviewRow(repetition.review, seenStateKeys)}`;
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

function renderTreatmentRow(detail: ExperimentDetailView, treatment: TreatmentView, seenStateKeys: Set<string>): string {
  return `<tr>
      <td><b>${escapeHtml(treatment.treatmentId)}</b><br><span class="kind mono">run folder ${escapeHtml(treatment.run)}</span></td>
      <td>${escapeHtml(treatment.verdictDistribution)}</td>
      <td class="mono">${escapeHtml(treatment.meanTurns)}</td>
      <td class="mono">${escapeHtml(treatment.meanTokensIn)}</td>
      <td class="mono">${escapeHtml(treatment.meanNudgesPerRepetition)}</td>
    </tr>
    <tr>
      <td colspan="5">
        ${renderFilterBar(treatment.repetitions.length)}
        <table class="repetitions">
          <thead><tr><th>case · repetition</th><th>verdict</th><th>starts from</th><th>lines added / removed</th><th>turns</th><th>input tokens</th><th>nudges</th><th>detail</th></tr></thead>
          <tbody>${treatment.repetitions.map((repetition) => renderRepetitionRow(detail, treatment.treatmentId, repetition, seenStateKeys)).join("")}</tbody>
        </table>
      </td>
    </tr>`;
}

function renderTreatmentsTable(detail: ExperimentDetailView, seenStateKeys: Set<string>): string {
  return `<table class="treatments">
    <thead><tr><th>treatment</th><th>verdicts</th><th>mean turns</th><th>mean input tokens</th><th>mean nudges/repetition</th></tr></thead>
    <tbody>${detail.treatments.map((treatment) => renderTreatmentRow(detail, treatment, seenStateKeys)).join("")}</tbody>
  </table>`;
}

function renderPerCaseRow(row: PerCaseRowView): string {
  const cells = row.cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("");
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

function renderExperimentDetail(detail: ExperimentDetailView, seenStateKeys: Set<string>): string {
  return `<section id="experiment-${escapeHtml(detail.id)}" class="experiment-detail">
    <div class="crumb"><a href="#top">Experiments</a> › <b>${escapeHtml(detail.name)}</b></div>
    <h2>${escapeHtml(detail.name)} <span class="kind">· ${escapeHtml(detail.kindLabel)}</span></h2>
    <p>${escapeHtml(detail.question)}</p>
    <div class="outcome-box"><span class="kind">outcome</span><br>${escapeHtml(detail.outcome)}</div>
    ${renderSetupCheck(detail.setupCheck)}
    <h3>Treatments</h3>
    ${renderTreatmentsTable(detail, seenStateKeys)}
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
    var pre = col.querySelector(".code-text");
    var label = col.querySelector(".label").textContent;
    if (pre) return { text: pre.textContent, label: label };
    var link = col.querySelector("a[href^='#']");
    if (link) {
      var target = document.getElementById(link.getAttribute("href").slice(1));
      return { text: target ? target.textContent : "", label: label };
    }
    return { text: "", label: label };
  }

  function referenceTextFor(section) {
    var pre = section.querySelector("[data-reference-state]");
    return pre ? pre.textContent : "";
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

    function render() {
      var beforeInfo = state.useReference ? { text: referenceTextFor(section), label: "case reference" } : stateTextAndLabel(section, state.before);
      var afterInfo = stateTextAndLabel(section, state.after);
      if (!beforeInfo || !afterInfo) return;
      var ops = lineDiff(beforeInfo.text, afterInfo.text);
      holder.innerHTML = state.view === "unified" ? unifiedHtml(beforeInfo.label, afterInfo.label, ops) : sideBySideHtml(beforeInfo.label, afterInfo.label, ops);
    }

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
        render();
      });
    });
  });
})();
</script>`;

export function renderReportHtml(model: ReportViewModel): string {
  const seenStateKeys = new Set<string>();

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>liubai eval report</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1 id="top">Experiments</h1>
${model.milestones.map(renderMilestone).join("")}
${renderUnclaimed(model.unclaimedRunFolders)}
${model.experimentDetails.map((detail) => renderExperimentDetail(detail, seenStateKeys)).join("")}
${FILTER_SCRIPT}
${REVIEW_SCRIPT}
</body>
</html>
`;
}
