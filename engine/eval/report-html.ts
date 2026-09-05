import type { ExperimentDetailView, ExperimentView, MilestoneView, PerCaseRowView, RepetitionView, ReportViewModel, SetupCheckView, TreatmentView } from "./report-view.ts";

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

function renderRepetitionRow(detail: ExperimentDetailView, treatmentId: string, repetition: RepetitionView): string {
  const successful = repetition.verdict === detail.successVerdict ? "1" : "0";
  const nudged = repetition.nudged ? "1" : "0";
  const control = treatmentId === detail.controlTreatmentId ? "1" : "0";

  return `<tr data-repetition="${escapeHtml(repetition.id)}" data-successful="${successful}" data-nudged="${nudged}" data-control="${control}">
      <td class="mono">${escapeHtml(repetition.caseId)} · ${repetition.repetition}</td>
      <td><span class="chip">${escapeHtml(repetition.verdict)}</span></td>
      <td>${escapeHtml(repetition.startsFromLabel)}</td>
      <td class="mono">${escapeHtml(repetition.linesAddedRemoved)}</td>
      <td class="mono">${escapeHtml(repetition.turns)}</td>
      <td class="mono">${escapeHtml(repetition.tokensIn)}</td>
      <td class="mono">${escapeHtml(repetition.nudges)}</td>
      <td class="detail">${escapeHtml(repetition.detail)}</td>
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

function renderTreatmentRow(detail: ExperimentDetailView, treatment: TreatmentView): string {
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
          <tbody>${treatment.repetitions.map((repetition) => renderRepetitionRow(detail, treatment.treatmentId, repetition)).join("")}</tbody>
        </table>
      </td>
    </tr>`;
}

function renderTreatmentsTable(detail: ExperimentDetailView): string {
  return `<table class="treatments">
    <thead><tr><th>treatment</th><th>verdicts</th><th>mean turns</th><th>mean input tokens</th><th>mean nudges/repetition</th></tr></thead>
    <tbody>${detail.treatments.map((treatment) => renderTreatmentRow(detail, treatment)).join("")}</tbody>
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

function renderExperimentDetail(detail: ExperimentDetailView): string {
  return `<section id="experiment-${escapeHtml(detail.id)}" class="experiment-detail">
    <div class="crumb"><a href="#top">Experiments</a> › <b>${escapeHtml(detail.name)}</b></div>
    <h2>${escapeHtml(detail.name)} <span class="kind">· ${escapeHtml(detail.kindLabel)}</span></h2>
    <p>${escapeHtml(detail.question)}</p>
    <div class="outcome-box"><span class="kind">outcome</span><br>${escapeHtml(detail.outcome)}</div>
    ${renderSetupCheck(detail.setupCheck)}
    <h3>Treatments</h3>
    ${renderTreatmentsTable(detail)}
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

export function renderReportHtml(model: ReportViewModel): string {
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
${model.experimentDetails.map(renderExperimentDetail).join("")}
${FILTER_SCRIPT}
</body>
</html>
`;
}
