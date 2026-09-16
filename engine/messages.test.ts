import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { CC_DELTA_NUDGE, formatBlockReason, formatCcDeltaNudge, formatCcNudge, readNudgePhrasing, resolveCcDeltaNudge, resolveCcNudge } from "./messages.ts";
import type { CcNudgePhrasing } from "./messages.ts";
import type { Lang, Nudge } from "./contract.ts";

function phrasing(first: string, rest: string): CcNudgePhrasing {
  return { first, rest };
}

const DEFAULTS: Record<Lang, CcNudgePhrasing> = {
  python: phrasing("py first {name}", "py rest {name}"),
  typescript: phrasing("ts first {name}", "ts rest {name}"),
  cpp: phrasing("cpp first {name}", "cpp rest {name}"),
};

test("resolveCcNudge returns the defaults unchanged when the nudge phrasing is empty", () => {
  const result = resolveCcNudge(DEFAULTS, {});

  assert.deepEqual(result, DEFAULTS);
});

test("resolveCcNudge overrides only the langs present in the nudge phrasing", () => {
  const nudgePhrasing = { CC_NUDGE: { python: phrasing("coached first", "coached rest") } };

  const result = resolveCcNudge(DEFAULTS, nudgePhrasing);

  assert.deepEqual(result.python, phrasing("coached first", "coached rest"));
  assert.deepEqual(result.typescript, DEFAULTS.typescript);
  assert.deepEqual(result.cpp, DEFAULTS.cpp);
});

test("resolveCcNudge ignores a lang entry that is not an object", () => {
  const nudgePhrasing = { CC_NUDGE: { python: "not an object" } };

  const result = resolveCcNudge(DEFAULTS, nudgePhrasing);

  assert.deepEqual(result.python, DEFAULTS.python);
});

test("resolveCcNudge ignores a lang entry with non-string templates", () => {
  const nudgePhrasing = { CC_NUDGE: { python: { first: 42, rest: 43 } } };

  const result = resolveCcNudge(DEFAULTS, nudgePhrasing);

  assert.deepEqual(result.python, DEFAULTS.python);
});

test("resolveCcNudge ignores an unknown lang key", () => {
  const nudgePhrasing = { CC_NUDGE: { klingon: phrasing("f", "r") } };

  const result = resolveCcNudge(DEFAULTS, nudgePhrasing);

  assert.deepEqual(result, DEFAULTS);
});

test("resolveCcNudge ignores a nudge phrasing with no CC_NUDGE key", () => {
  const result = resolveCcNudge(DEFAULTS, { somethingElse: true });

  assert.deepEqual(result, DEFAULTS);
});

test("resolveCcNudge ignores a nudge phrasing that is not an object", () => {
  const result = resolveCcNudge(DEFAULTS, "not an object");

  assert.deepEqual(result, DEFAULTS);
});

test("formatCcNudge fills name, cc, and threshold placeholders", () => {
  const msg = formatCcNudge("{name} (CC={cc}). Threshold is {threshold}.", { name: "f", cc: 9, threshold: 8 });

  assert.equal(msg, "f (CC=9). Threshold is 8.");
});

test("formatCcNudge fills a placeholder appearing more than once", () => {
  const msg = formatCcNudge("{name} and {name}", { name: "f", cc: 9, threshold: 8 });

  assert.equal(msg, "f and f");
});

test("formatCcNudge leaves a template without placeholders untouched", () => {
  const msg = formatCcNudge("say it in one sentence", { name: "f", cc: 9, threshold: 8 });

  assert.equal(msg, "say it in one sentence");
});

test("formatCcDeltaNudge fills name, dpBefore, and dpAfter placeholders", () => {
  const msg = formatCcDeltaNudge("{name} ({dpBefore}->{dpAfter})", { name: "f", dpBefore: 11, dpAfter: 9 });

  assert.equal(msg, "f (11->9)");
});

test("formatCcDeltaNudge fills a placeholder appearing more than once", () => {
  const msg = formatCcDeltaNudge("{name} and {name}", { name: "f", dpBefore: 11, dpAfter: 9 });

  assert.equal(msg, "f and f");
});

test("formatCcDeltaNudge leaves a template without placeholders untouched", () => {
  const msg = formatCcDeltaNudge("say it in one sentence", { name: "f", dpBefore: 11, dpAfter: 9 });

  assert.equal(msg, "say it in one sentence");
});

test("CC_DELTA_NUDGE reads as the coaching guide's numberless voice", () => {
  const msg = formatCcDeltaNudge(CC_DELTA_NUDGE, { name: "handleRequest", dpBefore: 11, dpAfter: 11 });

  assert.equal(
    msg,
    "handleRequest dropped below the complexity threshold, but the file still carries the same decisions — the complexity moved, it did not leave. Splitting a tangle into helpers relocates branches without removing any; a reader now chases the same decisions across more functions. Go back to the shape: collapse branches that repeat a pattern into a dispatch/lookup, delete branches the function's one-sentence job does not need, and only keep helpers that stand for a genuinely separate job.",
  );
});

test("the default cc-delta nudge mentions no numbers once formatted with a name and decision-point counts", () => {
  const msg = formatCcDeltaNudge(CC_DELTA_NUDGE, { name: "handleRequest", dpBefore: 11, dpAfter: 9 });

  assert.doesNotMatch(msg, /[0-9]/);
});

const DEFAULT_DELTA_TEXT = "default delta text for {name}";

test("resolveCcDeltaNudge returns the default when the nudge phrasing has no CC_DELTA_NUDGE key", () => {
  const result = resolveCcDeltaNudge(DEFAULT_DELTA_TEXT, {});

  assert.equal(result, DEFAULT_DELTA_TEXT);
});

test("resolveCcDeltaNudge returns the nudge phrasing's string when present", () => {
  const result = resolveCcDeltaNudge(DEFAULT_DELTA_TEXT, { CC_DELTA_NUDGE: "overridden delta text" });

  assert.equal(result, "overridden delta text");
});

test("resolveCcDeltaNudge falls back to the default when CC_DELTA_NUDGE is not a string", () => {
  const result = resolveCcDeltaNudge(DEFAULT_DELTA_TEXT, { CC_DELTA_NUDGE: 42 });

  assert.equal(result, DEFAULT_DELTA_TEXT);
});

test("resolveCcDeltaNudge falls back to the default when the nudge phrasing is not an object", () => {
  const result = resolveCcDeltaNudge(DEFAULT_DELTA_TEXT, "not an object");

  assert.equal(result, DEFAULT_DELTA_TEXT);
});

test("readNudgePhrasing yields an empty object when the content is undefined", () => {
  const result = readNudgePhrasing(undefined);

  assert.deepEqual(result, {});
});

test("readNudgePhrasing yields an empty object when the content is an empty string", () => {
  const result = readNudgePhrasing("");

  assert.deepEqual(result, {});
});

test("readNudgePhrasing throws naming LIUBAI_NUDGE_PHRASING when the content is malformed json", () => {
  assert.throws(() => readNudgePhrasing("{ not json"), /LIUBAI_NUDGE_PHRASING/);
});

test("readNudgePhrasing yields the parsed nudge phrasing when the content is valid json", () => {
  const result = readNudgePhrasing('{"CC_NUDGE":{"python":{"first":"f","rest":"r"}}}');

  assert.deepEqual(result, { CC_NUDGE: { python: { first: "f", rest: "r" } } });
});

function discourageCommentsNudge(): Nudge {
  return {
    rule: "discourage-comments",
    severity: "block",
    line: 7,
    msg:
      'L7: "# fixme" — comments are noise; write expressive code. ' +
      "Remove docstrings too, not just '#' lines. " +
      "If you truly think a WHY-comment is justified, propose it to the user before writing it.",
  };
}

test("formatBlockReason for a discourage-comments nudge never mentions cc nudge text", () => {
  const reason = formatBlockReason("app/foo.py", [discourageCommentsNudge()]);

  assert.doesNotMatch(reason, /dispatch dict|lookup object|dispatch table|too many decisions/);
  assert.match(reason, /fixme/);
});

const ENGINE_DIR = import.meta.dirname;
const MESSAGES_URL = pathToFileURL(join(ENGINE_DIR, "messages.ts")).href;
const POLICY_URL = pathToFileURL(join(ENGINE_DIR, "policy.ts")).href;

function scriptPrintingBlockReason(): string {
  return [
    `import { formatBlockReason } from "${MESSAGES_URL}";`,
    `const nudge = ${JSON.stringify(discourageCommentsNudge())};`,
    `process.stdout.write(formatBlockReason("app/foo.py", [nudge]));`,
  ].join("\n");
}

function overThresholdFunction(name: string, startLine: number): object {
  return {
    name,
    startLine,
    endLine: startLine + 2,
    cyclomaticComplexity: 9,
    missingAnnotations: [],
    isTest: false,
    bodyLineCount: 2,
    signature: "same",
    body: "changed",
    controlStatementCount: 0,
    rawAssertCount: 0,
    plumbingLines: 0,
  };
}

function scriptPrintingCcNudges(): string {
  return [
    `import { buildRules, DEFAULT_POLICY, RULE } from "${POLICY_URL}";`,
    `const functions = [${JSON.stringify(overThresholdFunction("alpha", 1))}, ${JSON.stringify(overThresholdFunction("beta", 20))}];`,
    `const ctx = { path: "app/foo.py", lang: "python", after: "x", env: {}, extracted: { functions, comments: [] } };`,
    `const cc = buildRules(DEFAULT_POLICY, "python").find((r) => r.name === RULE.cc);`,
    `const nudges = await cc.run(ctx);`,
    `process.stdout.write(JSON.stringify(nudges.map((n) => n.msg)));`,
  ].join("\n");
}

function inTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "nudge-phrasing-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runScript(source: string, env: NodeJS.ProcessEnv): string {
  return inTempDir((dir) => {
    const scriptPath = join(dir, "script.ts");
    writeFileSync(scriptPath, source);
    const run = spawnSync(process.execPath, ["--experimental-strip-types", scriptPath], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  });
}

function nudgePhrasing(ccNudge: object): string {
  return JSON.stringify({ CC_NUDGE: ccNudge });
}

function envWithout(name: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[name];
  return env;
}

function ccNudgeMsgsWithPhrasing(ccNudge: object): string[] {
  const stdout = runScript(scriptPrintingCcNudges(), { ...process.env, LIUBAI_NUDGE_PHRASING: nudgePhrasing(ccNudge) });
  return JSON.parse(stdout) as string[];
}

function blockReasonWithAndWithoutPhrasing(): { withoutPhrasing: string; withPhrasing: string } {
  const overridden = phrasing("OVERRIDDEN_CC_NUDGE", "OVERRIDDEN_CC_NUDGE");
  const content = nudgePhrasing({ python: overridden, typescript: overridden, cpp: overridden });
  return {
    withoutPhrasing: runScript(scriptPrintingBlockReason(), envWithout("LIUBAI_NUDGE_PHRASING")),
    withPhrasing: runScript(scriptPrintingBlockReason(), { ...process.env, LIUBAI_NUDGE_PHRASING: content }),
  };
}

test("formatBlockReason output is byte-identical whether or not a nudge phrasing overrode CC_NUDGE", () => {
  const { withoutPhrasing, withPhrasing } = blockReasonWithAndWithoutPhrasing();

  assert.equal(withoutPhrasing, withPhrasing);
  assert.doesNotMatch(withPhrasing, /OVERRIDDEN_CC_NUDGE/);
});

test("a nudge phrasing gives the first flagged function the full guide and later ones the short form", () => {
  const msgs = ccNudgeMsgsWithPhrasing({ python: phrasing("GUIDE for {name} (cc {cc}, bar {threshold})", "{name}: SAME") });

  assert.deepEqual(msgs, ["GUIDE for alpha (cc 9, bar 8)", "beta: SAME"]);
});

test("without a nudge phrasing the first flagged function gets the coaching guide and later ones the short form", () => {
  const stdout = runScript(scriptPrintingCcNudges(), envWithout("LIUBAI_NUDGE_PHRASING"));

  const msgs = JSON.parse(stdout) as string[];
  assert.equal(msgs.length, 2);
  assert.match(msgs[0]!, /^alpha is making too many decisions/);
  assert.match(msgs[0]!, /one sentence/);
  assert.match(msgs[1]!, /^beta: same smell/);
});

test("the default cc nudge never mentions the count or the threshold", () => {
  const stdout = runScript(scriptPrintingCcNudges(), envWithout("LIUBAI_NUDGE_PHRASING"));

  for (const msg of JSON.parse(stdout) as string[]) {
    assert.doesNotMatch(msg, /CC=|[Tt]hreshold|\b9\b|\b8\b/);
  }
});

function scriptPrintingCcDeltaNudge(): string {
  return [
    `import { buildRules, DEFAULT_POLICY, RULE } from "${POLICY_URL}";`,
    `const before = [{ name: "handleRequest", cyclomaticComplexity: 12 }];`,
    `const functions = [4, 4, 4, 3].map((cc, i) => ({ name: \`f\${i}\`, cyclomaticComplexity: cc, body: "changed" }));`,
    `const ctx = { path: "app/foo.py", lang: "python", after: "x", env: {}, extracted: { functions, comments: [], beforeFunctions: before } };`,
    `const ccDelta = buildRules(DEFAULT_POLICY, "python").find((r) => r.name === RULE.ccDelta);`,
    `const nudges = await ccDelta.run(ctx);`,
    `process.stdout.write(JSON.stringify(nudges.map((n) => n.msg)));`,
  ].join("\n");
}

function deltaNudgePhrasing(ccDeltaNudge: string): string {
  return JSON.stringify({ CC_DELTA_NUDGE: ccDeltaNudge });
}

test("a nudge phrasing overrides the cc-delta nudge text at rail runtime", () => {
  const content = deltaNudgePhrasing("{name} custom delta text ({dpBefore}->{dpAfter})");
  const stdout = runScript(scriptPrintingCcDeltaNudge(), { ...process.env, LIUBAI_NUDGE_PHRASING: content });
  const msgs = JSON.parse(stdout) as string[];

  assert.deepEqual(msgs, ["handleRequest custom delta text (11->11)"]);
});

test("without a nudge phrasing the cc-delta rule keeps its default text", () => {
  const stdout = runScript(scriptPrintingCcDeltaNudge(), envWithout("LIUBAI_NUDGE_PHRASING"));

  const msgs = JSON.parse(stdout) as string[];
  assert.deepEqual(msgs, [formatCcDeltaNudge(CC_DELTA_NUDGE, { name: "handleRequest", dpBefore: 11, dpAfter: 11 })]);
});
