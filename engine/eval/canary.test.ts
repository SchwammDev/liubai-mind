import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateCanary, parseProbeStdout } from "./canary.ts";
import type { EvaluateCanaryInput, CanaryResult } from "./canary.ts";
import type { ProbeReport } from "../delivery-probe.ts";
import { PROBE_FIXTURES } from "../delivery-probe.ts";
import type { FixtureLang } from "../delivery-probe.ts";
import { CC_DELTA_NUDGE, CC_NUDGE, formatCcNudge } from "../messages.ts";
import { DEFAULT_POLICY } from "../policy.ts";
import { RULE, packHash } from "../contract.ts";
import type { ConditionManifest } from "./eval-contract.ts";

function fixtureFor(lang: FixtureLang) {
  const fixture = PROBE_FIXTURES.find((f) => f.lang === lang);
  assert.ok(fixture, `expected a ${lang} probe fixture`);
  return fixture;
}

function thresholdFor(lang: FixtureLang): number {
  const threshold = DEFAULT_POLICY[RULE.cc].threshold?.[lang];
  assert.ok(threshold !== undefined, `expected a cc threshold for ${lang}`);
  return threshold;
}

function defaultNudgeText(lang: FixtureLang): string {
  const fixture = fixtureFor(lang);
  return formatCcNudge(CC_NUDGE[lang].first, { name: fixture.functionName, cc: fixture.cyclomaticComplexity, threshold: thresholdFor(lang) });
}

function reportWithNudges(overrides: Partial<ProbeReport> = {}): ProbeReport {
  return {
    packHash: null,
    nudges: { python: [defaultNudgeText("python")], typescript: [defaultNudgeText("typescript")] },
    errors: [],
    ccNudge: CC_NUDGE,
    ccDeltaNudge: CC_DELTA_NUDGE,
    ...overrides,
  };
}

const PACK_CONTENT = JSON.stringify({
  CC_NUDGE: {
    python: { first: "{name} python-first ({cc}/{threshold})", rest: "{name} python-rest" },
    typescript: { first: "{name} ts-first ({cc}/{threshold})", rest: "{name} ts-rest" },
  },
  CC_DELTA_NUDGE: "custom delta text",
});

function packedReport(): ProbeReport {
  return {
    packHash: packHash(PACK_CONTENT),
    nudges: {
      python: [formatCcNudge("{name} python-first ({cc}/{threshold})", { name: fixtureFor("python").functionName, cc: fixtureFor("python").cyclomaticComplexity, threshold: thresholdFor("python") })],
      typescript: [formatCcNudge("{name} ts-first ({cc}/{threshold})", { name: fixtureFor("typescript").functionName, cc: fixtureFor("typescript").cyclomaticComplexity, threshold: thresholdFor("typescript") })],
    },
    errors: [],
    ccNudge: {
      python: { first: "{name} python-first ({cc}/{threshold})", rest: "{name} python-rest" },
      typescript: { first: "{name} ts-first ({cc}/{threshold})", rest: "{name} ts-rest" },
      cpp: CC_NUDGE.cpp,
    },
    ccDeltaNudge: "custom delta text",
  };
}

function condition(overrides: Partial<ConditionManifest> = {}): ConditionManifest {
  return { id: "test-condition", env: {}, ...overrides };
}

function input(overrides: Partial<EvaluateCanaryInput> = {}): EvaluateCanaryInput {
  return {
    condition: condition(),
    packContent: undefined,
    exitCode: 0,
    stdout: `${JSON.stringify(reportWithNudges())}\n`,
    stderr: "",
    ...overrides,
  };
}

function assertCanaryPasses(result: CanaryResult): void {
  assert.equal(result.ok, true);
}

function assertCanaryFails(result: CanaryResult, pattern: RegExp): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, pattern);
}

test("evaluateCanary_passes_when_the_probe_confirms_default_phrasing_and_no_pack", () => {
  const result = evaluateCanary(input());

  assertCanaryPasses(result);
});

test("evaluateCanary_names_the_condition_and_exit_code_when_the_probe_crashes", () => {
  const result = evaluateCanary(input({ condition: condition({ id: "coaching-v1" }), exitCode: 1, stdout: "", stderr: "boom" }));

  assertCanaryFails(result, /coaching-v1/);
  assertCanaryFails(result, /exited 1/);
});

test("evaluateCanary_fails_when_stdout_is_not_valid_json", () => {
  const result = evaluateCanary(input({ stdout: "not json\n" }));

  assertCanaryFails(result, /not valid JSON/);
});

test("evaluateCanary_fails_when_the_probe_reported_analyze_errors", () => {
  const report = reportWithNudges({ errors: [{ source: "extract:python", msg: "boom" }] });
  const result = evaluateCanary(input({ stdout: `${JSON.stringify(report)}\n` }));

  assertCanaryFails(result, /analyze errors/);
  assertCanaryFails(result, /extract:python/);
});

test("evaluateCanary_fails_when_a_packless_condition_reports_a_nonnull_packHash", () => {
  const report = reportWithNudges({ packHash: "deadbeef" });
  const result = evaluateCanary(input({ stdout: `${JSON.stringify(report)}\n` }));

  assertCanaryFails(result, /packHash mismatch/);
});

test("evaluateCanary_fails_when_the_default_cc_phrasing_never_reaches_the_produced_nudge", () => {
  const report = reportWithNudges({ nudges: { python: ["unrelated text"], typescript: [defaultNudgeText("typescript")] } });
  const result = evaluateCanary(input({ stdout: `${JSON.stringify(report)}\n` }));

  assertCanaryFails(result, /python/);
});

test("evaluateCanary_passes_when_a_packed_condition_delivers_the_overridden_cc_phrasing", () => {
  const result = evaluateCanary(input({
    condition: condition({ phrasingPack: "packs/x.json" }),
    packContent: PACK_CONTENT,
    stdout: `${JSON.stringify(packedReport())}\n`,
  }));

  assertCanaryPasses(result);
});

test("evaluateCanary_fails_when_a_packed_conditions_override_text_never_reaches_the_produced_nudge", () => {
  const report = packedReport();
  report.nudges.python = ["unrelated text"];
  const result = evaluateCanary(input({
    condition: condition({ phrasingPack: "packs/x.json" }),
    packContent: PACK_CONTENT,
    stdout: `${JSON.stringify(report)}\n`,
  }));

  assertCanaryFails(result, /python/);
});

test("evaluateCanary_fails_when_the_resolved_CC_DELTA_NUDGE_does_not_match_the_pack", () => {
  const report = packedReport();
  report.ccDeltaNudge = "something else";
  const result = evaluateCanary(input({
    condition: condition({ phrasingPack: "packs/x.json" }),
    packContent: PACK_CONTENT,
    stdout: `${JSON.stringify(report)}\n`,
  }));

  assertCanaryFails(result, /CC_DELTA_NUDGE mismatch/);
});

test("evaluateCanary_on_a_rails_off_condition_checks_resolved_constants_and_ignores_produced_nudges", () => {
  const report = packedReport();
  report.nudges = { python: [], typescript: [] };
  const result = evaluateCanary(input({
    condition: condition({ env: { LIUBAI_RAILS_OFF: "1" }, phrasingPack: "packs/x.json" }),
    packContent: PACK_CONTENT,
    stdout: `${JSON.stringify(report)}\n`,
  }));

  assertCanaryPasses(result);
});

test("evaluateCanary_on_a_rails_off_condition_still_catches_a_stale_resolved_CC_NUDGE_constant", () => {
  const report = packedReport();
  report.nudges = { python: [], typescript: [] };
  report.ccNudge = { ...report.ccNudge, python: { ...report.ccNudge.python, first: "stale text" } };
  const result = evaluateCanary(input({
    condition: condition({ env: { LIUBAI_RAILS_OFF: "1" }, phrasingPack: "packs/x.json" }),
    packContent: PACK_CONTENT,
    stdout: `${JSON.stringify(report)}\n`,
  }));

  assertCanaryFails(result, /CC_NUDGE\.python mismatch/);
});

test("parseProbeStdout_reads_the_last_json_line_and_ignores_leading_noise", () => {
  const stdout = `some warning\n${JSON.stringify(reportWithNudges())}\n`;

  const result = parseProbeStdout(stdout);

  assert.equal("error" in result, false);
});

test("parseProbeStdout_reports_an_error_when_stdout_is_empty", () => {
  const result = parseProbeStdout("");

  assert.ok("error" in result);
});
