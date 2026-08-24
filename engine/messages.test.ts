import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { formatBlockReason, readPack, resolveCcAdvice } from "./messages.ts";
import type { Lang, Nudge } from "./contract.ts";

const DEFAULTS: Record<Lang, string> = {
  python: "replace if/elif chains with dispatch dicts",
  typescript: "replace if/else chains with lookup objects",
  cpp: "replace if/else chains with dispatch tables",
};

test("resolveCcAdvice returns the defaults unchanged when the pack is empty", () => {
  const result = resolveCcAdvice(DEFAULTS, {});

  assert.deepEqual(result, DEFAULTS);
});

test("resolveCcAdvice overrides only the langs present in the pack", () => {
  const pack = { CC_ADVICE: { python: "use match statements" } };

  const result = resolveCcAdvice(DEFAULTS, pack);

  assert.equal(result.python, "use match statements");
  assert.equal(result.typescript, DEFAULTS.typescript);
  assert.equal(result.cpp, DEFAULTS.cpp);
});

test("resolveCcAdvice ignores a non-string advice value", () => {
  const pack = { CC_ADVICE: { python: 42 } };

  const result = resolveCcAdvice(DEFAULTS, pack);

  assert.equal(result.python, DEFAULTS.python);
});

test("resolveCcAdvice ignores an unknown lang key", () => {
  const pack = { CC_ADVICE: { klingon: "use bat'leth patterns" } };

  const result = resolveCcAdvice(DEFAULTS, pack);

  assert.deepEqual(result, DEFAULTS);
});

test("resolveCcAdvice ignores a pack with no CC_ADVICE key", () => {
  const result = resolveCcAdvice(DEFAULTS, { somethingElse: true });

  assert.deepEqual(result, DEFAULTS);
});

test("resolveCcAdvice ignores a pack that is not an object", () => {
  const result = resolveCcAdvice(DEFAULTS, "not an object");

  assert.deepEqual(result, DEFAULTS);
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
  const result = readPack("/pack.json", () => '{"CC_ADVICE":{"python":"x"}}');

  assert.deepEqual(result, { CC_ADVICE: { python: "x" } });
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

test("formatBlockReason for a discourage-comments nudge never mentions CC_ADVICE text", () => {
  const reason = formatBlockReason("app/foo.py", [discourageCommentsNudge()]);

  assert.doesNotMatch(reason, /dispatch dicts|lookup objects|dispatch tables/);
  assert.match(reason, /fixme/);
});

const MESSAGES_URL = pathToFileURL(join(import.meta.dirname, "messages.ts")).href;

function scriptPrintingBlockReason(): string {
  return [
    `import { formatBlockReason } from "${MESSAGES_URL}";`,
    `const nudge = ${JSON.stringify(discourageCommentsNudge())};`,
    `process.stdout.write(formatBlockReason("app/foo.py", [nudge]));`,
  ].join("\n");
}

function runBlockReasonScript(env: NodeJS.ProcessEnv): string {
  const dir = mkdtempSync(join(tmpdir(), "phrasing-pack-"));
  const scriptPath = join(dir, "print-block-reason.ts");
  writeFileSync(scriptPath, scriptPrintingBlockReason());

  try {
    const run = spawnSync(process.execPath, ["--experimental-strip-types", scriptPath], { encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeOverridePack(dir: string): string {
  const packPath = join(dir, "pack.json");
  const overridden = { python: "OVERRIDDEN_CC_ADVICE", typescript: "OVERRIDDEN_CC_ADVICE", cpp: "OVERRIDDEN_CC_ADVICE" };
  writeFileSync(packPath, JSON.stringify({ CC_ADVICE: overridden }));
  return packPath;
}

function envWithout(name: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[name];
  return env;
}

test("formatBlockReason output is byte-identical whether or not a phrasing pack overrode CC_ADVICE", () => {
  const dir = mkdtempSync(join(tmpdir(), "phrasing-pack-"));
  const packPath = writeOverridePack(dir);

  try {
    const withoutPack = runBlockReasonScript(envWithout("LIUBAI_PHRASING_PACK"));
    const withPack = runBlockReasonScript({ ...process.env, LIUBAI_PHRASING_PACK: packPath });

    assert.equal(withoutPack, withPack);
    assert.doesNotMatch(withPack, /OVERRIDDEN_CC_ADVICE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
