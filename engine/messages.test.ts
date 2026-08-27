import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { formatBlockReason, formatCcNudge, readPack, resolveCcNudge } from "./messages.ts";
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

test("resolveCcNudge returns the defaults unchanged when the pack is empty", () => {
  const result = resolveCcNudge(DEFAULTS, {});

  assert.deepEqual(result, DEFAULTS);
});

test("resolveCcNudge overrides only the langs present in the pack", () => {
  const pack = { CC_NUDGE: { python: phrasing("coached first", "coached rest") } };

  const result = resolveCcNudge(DEFAULTS, pack);

  assert.deepEqual(result.python, phrasing("coached first", "coached rest"));
  assert.deepEqual(result.typescript, DEFAULTS.typescript);
  assert.deepEqual(result.cpp, DEFAULTS.cpp);
});

test("resolveCcNudge ignores a lang entry that is not an object", () => {
  const pack = { CC_NUDGE: { python: "not an object" } };

  const result = resolveCcNudge(DEFAULTS, pack);

  assert.deepEqual(result.python, DEFAULTS.python);
});

test("resolveCcNudge ignores a lang entry with non-string templates", () => {
  const pack = { CC_NUDGE: { python: { first: 42, rest: 43 } } };

  const result = resolveCcNudge(DEFAULTS, pack);

  assert.deepEqual(result.python, DEFAULTS.python);
});

test("resolveCcNudge ignores an unknown lang key", () => {
  const pack = { CC_NUDGE: { klingon: phrasing("f", "r") } };

  const result = resolveCcNudge(DEFAULTS, pack);

  assert.deepEqual(result, DEFAULTS);
});

test("resolveCcNudge ignores a pack with no CC_NUDGE key", () => {
  const result = resolveCcNudge(DEFAULTS, { somethingElse: true });

  assert.deepEqual(result, DEFAULTS);
});

test("resolveCcNudge ignores a pack that is not an object", () => {
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

test("readPack yields an empty object when the path is undefined", () => {
  const result = readPack(undefined, () => {
    throw new Error("should not be called");
  });

  assert.deepEqual(result, {});
});

test("readPack yields an empty object when the reader throws", () => {
  const result = readPack("/does/not/exist.json", () => {
    throw new Error("ENOENT");
  });

  assert.deepEqual(result, {});
});

test("readPack yields an empty object when the file contains malformed json", () => {
  const result = readPack("/pack.json", () => "{ not json");

  assert.deepEqual(result, {});
});

test("readPack yields the parsed pack when the file is valid json", () => {
  const result = readPack("/pack.json", () => '{"CC_NUDGE":{"python":{"first":"f","rest":"r"}}}');

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
  const dir = mkdtempSync(join(tmpdir(), "phrasing-pack-"));
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

function writePack(dir: string, ccNudge: object): string {
  const packPath = join(dir, "pack.json");
  writeFileSync(packPath, JSON.stringify({ CC_NUDGE: ccNudge }));
  return packPath;
}

function envWithout(name: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[name];
  return env;
}

function ccNudgeMsgsWithPack(dir: string, ccNudge: object): string[] {
  const packPath = writePack(dir, ccNudge);
  const stdout = runScript(scriptPrintingCcNudges(), { ...process.env, LIUBAI_PHRASING_PACK: packPath });
  return JSON.parse(stdout) as string[];
}

function blockReasonWithAndWithoutPack(dir: string): { withoutPack: string; withPack: string } {
  const overridden = phrasing("OVERRIDDEN_CC_NUDGE", "OVERRIDDEN_CC_NUDGE");
  const packPath = writePack(dir, { python: overridden, typescript: overridden, cpp: overridden });
  return {
    withoutPack: runScript(scriptPrintingBlockReason(), envWithout("LIUBAI_PHRASING_PACK")),
    withPack: runScript(scriptPrintingBlockReason(), { ...process.env, LIUBAI_PHRASING_PACK: packPath }),
  };
}

test("formatBlockReason output is byte-identical whether or not a phrasing pack overrode CC_NUDGE", () => {
  const { withoutPack, withPack } = inTempDir(blockReasonWithAndWithoutPack);

  assert.equal(withoutPack, withPack);
  assert.doesNotMatch(withPack, /OVERRIDDEN_CC_NUDGE/);
});

test("a phrasing pack gives the first flagged function the full guide and later ones the short form", () => {
  const msgs = inTempDir((dir) =>
    ccNudgeMsgsWithPack(dir, { python: phrasing("GUIDE for {name} (cc {cc}, bar {threshold})", "{name}: SAME") }),
  );

  assert.deepEqual(msgs, ["GUIDE for alpha (cc 9, bar 8)", "beta: SAME"]);
});

test("without a pack the first flagged function gets the coaching guide and later ones the short form", () => {
  const stdout = runScript(scriptPrintingCcNudges(), envWithout("LIUBAI_PHRASING_PACK"));

  const msgs = JSON.parse(stdout) as string[];
  assert.equal(msgs.length, 2);
  assert.match(msgs[0]!, /^alpha is making too many decisions/);
  assert.match(msgs[0]!, /one sentence/);
  assert.match(msgs[1]!, /^beta: same smell/);
});

test("the default cc nudge never mentions the count or the threshold", () => {
  const stdout = runScript(scriptPrintingCcNudges(), envWithout("LIUBAI_PHRASING_PACK"));

  for (const msg of JSON.parse(stdout) as string[]) {
    assert.doesNotMatch(msg, /CC=|[Tt]hreshold|\b9\b|\b8\b/);
  }
});
