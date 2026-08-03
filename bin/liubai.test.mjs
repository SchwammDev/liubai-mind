import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIUBAI = join(REPO, "bin", "liubai");

function tmpRepo(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  mkdirSync(join(dir, "coverage"), { recursive: true });
  return dir;
}

function git(cwd, args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) assert.fail(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

function writeSnapshot(root, snapshot) {
  writeFileSync(join(root, "coverage", "snapshot.json"), JSON.stringify(snapshot));
}

function runCrap(cwd) {
  return spawnSync("bash", ["-c", `"${LIUBAI}" crap`], { cwd, encoding: "utf8" });
}

test("liubai_crap_passes_with_no_staged_typescript", () => {
  const root = tmpRepo("liubai-crap-empty-");
  try {
    writeFileSync(join(root, "README.md"), "hello\n");
    git(root, ["add", "README.md"]);

    const res = runCrap(root);

    assert.equal(res.status, 0, res.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("liubai_crap_passes_when_staged_ts_is_covered", () => {
  const root = tmpRepo("liubai-crap-covered-");
  try {
    const src = "export function f() {\n  return 1;\n}\n";
    writeFileSync(join(root, "foo.ts"), src);
    git(root, ["add", "foo.ts"]);
    writeSnapshot(root, { files: { "foo.ts": { executed: [1, 2, 3], missing: [] } } });

    const res = runCrap(root);

    assert.equal(res.status, 0, res.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("liubai_crap_fails_when_snapshot_is_missing", () => {
  const root = tmpRepo("liubai-crap-nocov-");
  try {
    writeFileSync(join(root, "foo.ts"), "export function f() {\n  return 1;\n}\n");
    git(root, ["add", "foo.ts"]);

    const res = runCrap(root);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /run tests with coverage first/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("liubai_crap_fails_when_staged_ts_has_no_coverage", () => {
  const root = tmpRepo("liubai-crap-uncovered-");
  try {
    const src = "export function f(x: number): number {\n  if (x > 0) return 1;\n  if (x < 0) return -1;\n  return 0;\n}\n";
    writeFileSync(join(root, "foo.ts"), src);
    git(root, ["add", "foo.ts"]);
    writeSnapshot(root, { files: { "foo.ts": { executed: [], missing: [1, 2, 3, 4, 5] } } });

    const res = runCrap(root);

    assert.equal(res.status, 1);
    assert.match(res.stderr, /CRAP threshold exceeded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
