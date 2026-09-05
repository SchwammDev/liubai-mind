import { test } from "node:test";
import assert from "node:assert/strict";

import { renderReportHtml } from "./report-html.ts";
import type { ExperimentView, ReportViewModel } from "./report-view.ts";

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
