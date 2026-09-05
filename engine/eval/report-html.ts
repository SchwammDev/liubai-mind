import type { ExperimentView, MilestoneView, ReportViewModel } from "./report-view.ts";

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
`;

function renderTreatments(treatmentIds: string[]): string {
  return treatmentIds.map((id) => `<span class="chip">${escapeHtml(id)}</span>`).join(" ");
}

function renderExperimentRow(experiment: ExperimentView): string {
  return `<tr data-experiment="${escapeHtml(experiment.id)}">
      <td><b>${escapeHtml(experiment.name)}</b><br><span class="kind">${escapeHtml(experiment.kindLabel)}</span></td>
      <td>${escapeHtml(experiment.question)}</td>
      <td>${renderTreatments(experiment.treatmentIds)}</td>
      <td>${escapeHtml(experiment.model)}<br>${escapeHtml(experiment.tierLabel)}</td>
      <td>${escapeHtml(experiment.size)}</td>
      <td><span class="chip">${escapeHtml(experiment.status)}</span> ${escapeHtml(experiment.outcome)}</td>
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

export function renderReportHtml(model: ReportViewModel): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>liubai eval report</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<h1>Experiments</h1>
${model.milestones.map(renderMilestone).join("")}
${renderUnclaimed(model.unclaimedRunFolders)}
</body>
</html>
`;
}
