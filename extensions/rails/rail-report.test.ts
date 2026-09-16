import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { railReportTo } from "./rail-report.ts";

function tempReportPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "liubai-rail-report-"));
  return join(dir, "report.jsonl");
}

test("each_reported_line_reaches_the_channel_as_one_json_line", () => {
  const path = tempReportPath();
  const fd = openSync(path, "w");
  const report = railReportTo(fd);

  report({ type: "delivered", nudgePhrasingHash: null, liveRules: ["cc"], shadowRules: [] });
  report({ type: "shadow", rule: "cc", path: "/tmp/liubai-rail-report/foo.py" });
  closeSync(fd);

  const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    { type: "delivered", nudgePhrasingHash: null, liveRules: ["cc"], shadowRules: [] },
    { type: "shadow", rule: "cc", path: "/tmp/liubai-rail-report/foo.py" },
  ]);
});

test("a_missing_channel_is_ignored_rather_than_crashing_the_rail", () => {
  const path = tempReportPath();
  const fd = openSync(path, "w");
  closeSync(fd);
  const report = railReportTo(fd);

  assert.doesNotThrow(() => report({ type: "shadow", rule: "cc", path: "/tmp/liubai-rail-report/foo.py" }));
});
