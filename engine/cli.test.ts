import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import type { AnalyzeResp } from "./contract.ts";

const CLI_PATH = join(import.meta.dirname, "cli.ts");

function runCli(input: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", CLI_PATH], {
    input,
    encoding: "utf8",
  });
}

test("a trivial supported-lang req exits 0 with an empty response", () => {
  const req = JSON.stringify({ path: "app/foo.py", after: "x = 1" });

  const res = runCli(req);

  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  assert.deepEqual(JSON.parse(res.stdout), { nudges: [], errors: [] } satisfies AnalyzeResp);
});

test("a complex python req surfaces a cyclomatic-complexity nudge over stdout", () => {
  const after = [
    "def flagged(x):",
    "    if x == 1: return 'one'",
    "    elif x == 2: return 'two'",
    "    elif x == 3: return 'three'",
    "    elif x == 4: return 'four'",
    "    elif x == 5: return 'five'",
    "    elif x == 6: return 'six'",
    "    elif x == 7: return 'seven'",
    "    elif x == 8: return 'eight'",
    "    elif x == 9: return 'nine'",
    "    elif x == 10: return 'ten'",
    "    elif x == 11: return 'eleven'",
    "    else: return 'other'",
  ].join("\n");

  const res = runCli(JSON.stringify({ path: "app/foo.py", after }));

  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  const resp = JSON.parse(res.stdout) as AnalyzeResp;
  assert.ok(resp.nudges.some((n) => n.rule === "cc"), "expected at least one cc nudge");
});

test("an unknown-extension req exits 0 with an empty response", () => {
  const req = JSON.stringify({ path: "README.md", after: "hello" });

  const res = runCli(req);

  assert.equal(res.status, 0);
  assert.deepEqual(JSON.parse(res.stdout), { nudges: [], errors: [] } satisfies AnalyzeResp);
});

test("malformed json exits 1 with empty stdout and a stderr message", () => {
  const res = runCli("{ not json");

  assert.equal(res.status, 1);
  assert.equal(res.stdout, "");
  assert.ok(res.stderr.trim().length > 0);
});

test("a non-object payload exits 1 with empty stdout and a stderr message", () => {
  const res = runCli("42");

  assert.equal(res.status, 1);
  assert.equal(res.stdout, "");
  assert.ok(res.stderr.trim().length > 0);
});

test("a payload missing required fields exits 1 with empty stdout and a stderr message", () => {
  const res = runCli("{}");

  assert.equal(res.status, 1);
  assert.equal(res.stdout, "");
  assert.match(res.stderr, /^[^\n]+\n$/);
});
