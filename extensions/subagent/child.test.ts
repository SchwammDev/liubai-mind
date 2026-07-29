import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  selectMode,
  loadProfilesRaw,
  extractProfiles,
  validateProfile,
  validateProfilesConfig,
  firstProfileName,
  loadActiveProfileName,
  loadComplexitySelection,
  aggregateUsage,
  getFinalOutput,
  getResultOutput,
  MAX_PARALLEL_TASKS,
  REPORT_CAP,
  assessReport,
  gateReport,
  compressPrompt,
  truncationNotice,
  canSpawn,
  childDepthOf,
  currentDepth,
  isFailedResult,
  assessQuestion,
  buildClarifyTitle,
  CLARIFY_TAG,
  QUESTION_CAP,
  MAX_CLARIFY,
  CLARIFY_TIMEOUT_MS,
  type SingleResult,
} from "./child.ts";

const assistantSaying = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

const childResult = (overrides: Partial<SingleResult>): SingleResult => ({
  task: "do the thing",
  exitCode: 0,
  messages: [],
  stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  ...overrides,
});

test("a lone task with a complexity selects single mode", () => {
  const selection = selectMode({ task: "summarize the changelog", complexity: "easy" });

  assert.deepEqual(selection, { kind: "single" });
});

test("a tasks array with complexities selects parallel mode", () => {
  const selection = selectMode({
    tasks: [
      { task: "lint", complexity: "trivial" },
      { task: "typecheck", complexity: "medium" },
    ],
  });

  assert.deepEqual(selection, { kind: "parallel" });
});

test("providing both task and tasks is rejected as ambiguous", () => {
  const selection = selectMode({ task: "one", complexity: "easy", tasks: [{ task: "two", complexity: "easy" }] });

  assert.equal(selection.kind, "error");
});

test("providing neither task nor tasks is rejected", () => {
  const selection = selectMode({});

  assert.equal(selection.kind, "error");
});

test("more parallel tasks than the cap are rejected", () => {
  const tooMany = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({
    task: `task ${i}`,
    complexity: "easy",
  }));

  const selection = selectMode({ tasks: tooMany });

  assert.equal(selection.kind, "error");
});

test("a single task without a complexity is rejected", () => {
  const selection = selectMode({ task: "summarize the changelog" });

  assert.equal(selection.kind, "error");
});

test("an unknown complexity value is rejected", () => {
  const selection = selectMode({ task: "summarize the changelog", complexity: "impossible" });

  assert.equal(selection.kind, "error");
});

test("a parallel task item without a complexity is rejected", () => {
  const selection = selectMode({ tasks: [{ task: "lint", complexity: "easy" }, { task: "typecheck" }] });

  assert.equal(selection.kind, "error");
});

const profileConfigFiles = (complexity: string, active?: string): { configPath: string; profilePath: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "complexity-"));
  const configPath = path.join(dir, "complexity.json");
  fs.writeFileSync(configPath, complexity);
  const profilePath = path.join(dir, "active-profile.json");
  if (active !== undefined) fs.writeFileSync(profilePath, active);
  return { configPath, profilePath };
};

const FULL_TIER_MAP = { trivial: "t-model", easy: "e-model", medium: "m-model", hard: "h-model" };

const PROFILES = { default: FULL_TIER_MAP, heavy: { ...FULL_TIER_MAP, hard: "h-heavy" } };

test("a nested config returns the active profile's tier map", () => {
  const { configPath, profilePath } = profileConfigFiles(
    JSON.stringify({ profiles: PROFILES }),
    JSON.stringify({ profile: "heavy" }),
  );

  const selection = loadComplexitySelection(configPath, profilePath);

  assert.equal(selection.profile, "heavy");
  assert.deepEqual(selection.map, PROFILES.heavy);
});

test("a flat form config is rejected naming the profiles target shape", () => {
  const { configPath, profilePath } = profileConfigFiles(JSON.stringify(FULL_TIER_MAP));

  assert.throws(() => loadComplexitySelection(configPath, profilePath), /profiles/);
});

test("a profile missing a tier is rejected", () => {
  const profiles = { default: { trivial: "t", easy: "e", medium: "m" } };
  const { configPath, profilePath } = profileConfigFiles(JSON.stringify({ profiles }), JSON.stringify({ profile: "default" }));

  assert.throws(() => loadComplexitySelection(configPath, profilePath), /hard/);
});

test("a profile with an empty model id is rejected", () => {
  const profiles = { default: { ...FULL_TIER_MAP, easy: "" } };
  const { configPath, profilePath } = profileConfigFiles(JSON.stringify({ profiles }), JSON.stringify({ profile: "default" }));

  assert.throws(() => loadComplexitySelection(configPath, profilePath), /easy/);
});

test("the active profile is selected by name", () => {
  const { configPath, profilePath } = profileConfigFiles(
    JSON.stringify({ profiles: PROFILES }),
    JSON.stringify({ profile: "default" }),
  );

  const selection = loadComplexitySelection(configPath, profilePath);

  assert.equal(selection.profile, "default");
  assert.deepEqual(selection.map, PROFILES.default);
});

test("the first profile in insertion order is used when active-profile.json is absent", () => {
  const { configPath, profilePath } = profileConfigFiles(JSON.stringify({ profiles: PROFILES }));

  const selection = loadComplexitySelection(configPath, profilePath);

  assert.equal(selection.profile, "default");
  assert.deepEqual(selection.map, PROFILES.default);
});

test("an unknown active profile name is rejected listing the available profiles", () => {
  const { configPath, profilePath } = profileConfigFiles(
    JSON.stringify({ profiles: PROFILES }),
    JSON.stringify({ profile: "ghost" }),
  );

  assert.throws(() => loadComplexitySelection(configPath, profilePath), /ghost/);
});

test("validateProfilesConfig flags a flat form naming the profiles target shape", () => {
  const problems = validateProfilesConfig(FULL_TIER_MAP);

  assert.ok(problems.length > 0, "flat form should be flagged");
  assert.ok(problems.some((p) => /profiles/.test(p)), "flat complaint should name the target shape");
});

test("validateProfilesConfig reports each bad profile among good ones", () => {
  const profiles = {
    good: FULL_TIER_MAP,
    missingTier: { trivial: "t", easy: "e", medium: "m" },
    emptyModel: { ...FULL_TIER_MAP, easy: "" },
  };
  const problems = validateProfilesConfig({ profiles });

  assert.ok(problems.some((p) => /missingTier/.test(p) && /hard/.test(p)), "missing tier flagged for its profile");
  assert.ok(problems.some((p) => /emptyModel/.test(p) && /easy/.test(p)), "empty model flagged for its profile");
  assert.ok(!problems.some((p) => /^good/.test(p)), "the good profile should not be flagged");
});

test("loadProfilesRaw throws on a missing config file naming the path and the example file", () => {
  const missing = path.join(os.tmpdir(), "does-not-exist", "complexity.json");

  assert.throws(() => loadProfilesRaw(missing), (e: Error) => {
    assert.match(e.message, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(e.message, /complexity\.example\.json/);
    return true;
  });
});

test("loadProfilesRaw throws on malformed JSON naming the path and the example file", () => {
  const { configPath } = profileConfigFiles("{ not json");

  assert.throws(() => loadProfilesRaw(configPath), (e: Error) => {
    assert.match(e.message, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(e.message, /complexity\.example\.json/);
    return true;
  });
});

test("extractProfiles returns the profiles object for a nested config and null for a flat form", () => {
  assert.deepEqual(extractProfiles({ profiles: PROFILES }), PROFILES);
  assert.equal(extractProfiles(FULL_TIER_MAP), null);
});

test("validateProfile flags a profile with an extra tier key", () => {
  assert.match(validateProfile("p", { ...FULL_TIER_MAP, extreme: "x" })!, /extreme/);
});

test("firstProfileName returns the first profile in insertion order, or undefined when empty", () => {
  assert.equal(firstProfileName(PROFILES), "default");
  assert.equal(firstProfileName({}), undefined);
});

test("loadActiveProfileName returns undefined when the active-profile file is absent", () => {
  const { profilePath } = profileConfigFiles(JSON.stringify({ profiles: PROFILES }));

  assert.equal(loadActiveProfileName(profilePath), undefined);
});

test("loadActiveProfileName returns the selected name when present", () => {
  const { profilePath } = profileConfigFiles(
    JSON.stringify({ profiles: PROFILES }),
    JSON.stringify({ profile: "heavy" }),
  );

  assert.equal(loadActiveProfileName(profilePath), "heavy");
});

test("a report under the cap is accepted", () => {
  assert.deepEqual(assessReport("short report"), { kind: "accepted" });
});

test("a report exactly at the cap is accepted", () => {
  const at = "x".repeat(REPORT_CAP);

  assert.deepEqual(assessReport(at), { kind: "accepted" });
});

test("a report over the cap needs compress with its byte count", () => {
  const over = "x".repeat(REPORT_CAP + 100);

  assert.deepEqual(assessReport(over), { kind: "needs_compress", bytes: REPORT_CAP + 100 });
});

test("an accepted report passes through the gate without compressing", async () => {
  let calls = 0;
  const compress = async () => {
    calls++;
    return "should not be used";
  };

  const { report, verdict } = await gateReport("fine as is", undefined, compress);

  assert.equal(report, "fine as is");
  assert.deepEqual(verdict, { kind: "accepted" });
  assert.equal(calls, 0);
});

test("an oversized report whose compress lands under cap is returned accepted", async () => {
  let calls = 0;
  const original = "x".repeat(REPORT_CAP + 1);
  const compressed = "fits now";
  const compress = async (report: string) => {
    calls++;
    assert.equal(report, original);
    return compressed;
  };

  const { report, verdict } = await gateReport(original, undefined, compress);

  assert.equal(report, compressed);
  assert.deepEqual(verdict, { kind: "accepted" });
  assert.equal(calls, 1);
});

test("a report still over cap after compress is hard-truncated and flagged", async () => {
  let calls = 0;
  const original = "x".repeat(REPORT_CAP + 1);
  const stillOver = "y".repeat(REPORT_CAP + 50);
  const compress = async (report: string) => {
    calls++;
    assert.equal(report, original);
    return stillOver;
  };

  const { report, verdict } = await gateReport(original, undefined, compress);

  assert.ok(Buffer.byteLength(report, "utf8") <= REPORT_CAP);
  assert.equal(verdict.kind, "truncated");
  if (verdict.kind === "truncated") {
    assert.equal(verdict.bytes, Buffer.byteLength(stillOver, "utf8") - Buffer.byteLength(report, "utf8"));
  }
  assert.equal(calls, 1);
});

test("the truncation notice names the omitted byte count and the cap", () => {
  const notice = truncationNotice(50);

  assert.match(notice, /50 bytes/);
  assert.match(notice, /4 KB/);
});

test("the compress prompt states the 4 KB limit and output-only instruction", () => {
  const prompt = compressPrompt("x".repeat(REPORT_CAP + 1));

  assert.match(prompt, /4 ?KB/);
  assert.match(prompt, /4096/);
  assert.match(prompt, /only/i);
});

test("usage is summed across every child", () => {
  const results = [
    childResult({ usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 2 } }),
    childResult({ usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.02, contextTokens: 0, turns: 3 } }),
  ];

  const total = aggregateUsage(results);

  assert.equal(total.input, 150);
  assert.equal(total.output, 30);
  assert.equal(total.cost, 0.03);
  assert.equal(total.turns, 5);
});

test("the last assistant text is returned as the final output", () => {
  const messages = [assistantSaying("first pass"), assistantSaying("final answer")];

  assert.equal(getFinalOutput(messages as any), "final answer");
});

test("a failed child's output is capped at the report limit with a truncation notice", () => {
  const failed = childResult({ exitCode: 1, stderr: "x".repeat(3 * REPORT_CAP) });

  const output = getResultOutput(failed);

  assert.equal(output, `${"x".repeat(REPORT_CAP)}\n\n${truncationNotice(2 * REPORT_CAP)}`);
});

test("a failed child surfaces its error message over its partial output", () => {
  const failed = childResult({
    exitCode: 1,
    stopReason: "error",
    errorMessage: "provider timed out",
    messages: [assistantSaying("partial work so far") as any],
  });

  assert.equal(getResultOutput(failed), "provider timed out");
});

test("a child that dies before its first turn reports what its stderr said", () => {
  const crashed = childResult({
    exitCode: 1,
    settled: false,
    errorMessage: "child exited (code 1) before completing its turn",
    stderr: 'Error: Tool "bash" conflicts with /elsewhere/rails/index.ts\n',
  });

  const output = getResultOutput(crashed);

  assert.match(output, /before completing its turn/);
  assert.match(output, /conflicts with/);
});

test("a child that exits cleanly without settling is a failed result", () => {
  const unsettled = childResult({ exitCode: 0, settled: false });

  assert.equal(isFailedResult(unsettled), true);
});

test("a settled clean exit stays a successful result", () => {
  const settled = childResult({ exitCode: 0, settled: true });

  assert.equal(isFailedResult(settled), false);
});

test("only the top depth may spawn", () => {
  assert.equal(canSpawn(0), true);
  assert.equal(canSpawn(1), false);
  assert.equal(canSpawn(2), false);
});

test("a child sits one level below its parent", () => {
  assert.equal(childDepthOf(0), 1);
  assert.equal(childDepthOf(1), 2);
});

test("a missing or malformed depth falls back to the top", () => {
  const saved = process.env.LIUBAI_SPAWN_DEPTH;
  try {
    delete process.env.LIUBAI_SPAWN_DEPTH;
    assert.equal(currentDepth(), 0);

    process.env.LIUBAI_SPAWN_DEPTH = "abc";
    assert.equal(currentDepth(), 0);

    process.env.LIUBAI_SPAWN_DEPTH = "2";
    assert.equal(currentDepth(), 2);

    process.env.LIUBAI_SPAWN_DEPTH = "-1";
    assert.equal(currentDepth(), 0);
  } finally {
    if (saved === undefined) delete process.env.LIUBAI_SPAWN_DEPTH;
    else process.env.LIUBAI_SPAWN_DEPTH = saved;
  }
});

test("a question under the byte cap is accepted", () => {
  assert.deepEqual(assessQuestion("short question"), { kind: "accepted" });
});

test("a question exactly at the byte cap is accepted", () => {
  const at = "x".repeat(QUESTION_CAP);

  assert.deepEqual(assessQuestion(at), { kind: "accepted" });
});

test("a question over the byte cap is rejected with its byte count", () => {
  const over = "x".repeat(QUESTION_CAP + 1);

  assert.deepEqual(assessQuestion(over), { kind: "rejected", bytes: QUESTION_CAP + 1 });
});

test("assessQuestion measures UTF-8 bytes, not code units", () => {
  const question = "\u00e9".repeat(QUESTION_CAP);

  assert.deepEqual(assessQuestion(question), {
    kind: "rejected",
    bytes: Buffer.byteLength(question, "utf8"),
  });
});

test("buildClarifyTitle prefixes the question with the CLARIFY_TAG sentinel", () => {
  assert.equal(buildClarifyTitle("what now?"), CLARIFY_TAG + "what now?");
});

test("the clarify budget caps at two questions with a fifteen-minute timeout", () => {
  assert.equal(MAX_CLARIFY, 2);
  assert.equal(CLARIFY_TIMEOUT_MS, 15 * 60 * 1000);
});

test("at the capped depth a child may not spawn, but the top may", () => {
  const saved = process.env.LIUBAI_SPAWN_DEPTH;
  try {
    process.env.LIUBAI_SPAWN_DEPTH = "1";
    assert.equal(canSpawn(currentDepth()), false);

    delete process.env.LIUBAI_SPAWN_DEPTH;
    assert.equal(canSpawn(currentDepth()), true);
  } finally {
    if (saved === undefined) delete process.env.LIUBAI_SPAWN_DEPTH;
    else process.env.LIUBAI_SPAWN_DEPTH = saved;
  }
});
