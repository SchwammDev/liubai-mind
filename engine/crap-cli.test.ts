import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { runCrap, type CrapAdapter } from "./crap-cli.ts";
import type { CrapFunction } from "./crap.ts";
import type { Snapshot } from "./coverage-v8.ts";

const HIGH_CC_FN: CrapFunction = { name: "f", startLine: 1, endLine: 5, cc: 11 };

function tmpRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t.t"]);
  git(dir, ["config", "user.name", "t"]);
  return dir;
}

function rmTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function write(rel: string, root: string, content: string): string {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function git(cwd: string, args: string[]): string {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) assert.fail(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

function stageWithHunk(root: string, rel: string, content: string): void {
  write(rel, root, content);
  git(root, ["add", rel]);
  git(root, ["commit", "-qm", "base"]);
}

function amendLine(root: string, rel: string, content: string): void {
  fs.writeFileSync(path.join(root, ...rel.split("/")), content);
  git(root, ["add", rel]);
}

function fakeAdapter(opts: {
  exists?: boolean;
  mtime?: number;
  snapshot?: Snapshot;
  functions?: CrapFunction[];
}): CrapAdapter {
  const exists = opts.exists ?? true;
  const mtime = opts.mtime ?? Date.now() / 1000;
  return {
    snapshotExists: () => exists,
    snapshotMtime: () => mtime,
    loadSnapshot: () => opts.snapshot ?? { files: {} },
    extractFunctions: () => opts.functions ?? [],
  };
}

test("no_staged_ts_files_passes_without_needing_coverage", async () => {
  const root = tmpRepo("crap-empty-");

  try {
    const res = await runCrap({ cwd: root, adapter: fakeAdapter({ exists: false }) });

    assert.equal(res.status, 0);
    assert.equal(res.stderr, "");
  } finally {
    rmTree(root);
  }
});

test("missing_snapshot_fails_with_a_run_tests_message", async () => {
  const root = tmpRepo("crap-nocov-");
  try {
    stageWithHunk(root, "foo.ts", "function f() {\n  return 1;\n}\n");
    amendLine(root, "foo.ts", "function f() {\n  return 2;\n}\n");

    const res = await runCrap({ cwd: root, adapter: fakeAdapter({ exists: false }) });

    assert.equal(res.status, 1);
    assert.match(res.stderr, /run tests with coverage first/i);
  } finally {
    rmTree(root);
  }
});

test("stale_coverage_fails_before_evaluating_violations", async () => {
  const root = tmpRepo("crap-stale-");
  try {
    stageWithHunk(root, "foo.ts", "function f() {\n  return 1;\n}\n");
    const file = path.join(root, "foo.ts");
    fs.writeFileSync(file, "function f() {\n  return 2;\n}\n");
    git(root, ["add", "foo.ts"]);
    const future = (fs.statSync(file).mtimeMs / 1000) + 60;

    const res = await runCrap({
      cwd: root,
      adapter: fakeAdapter({ mtime: future - 120, functions: [HIGH_CC_FN] }),
    });

    assert.equal(res.status, 1);
    assert.match(res.stderr, /stale/i);
  } finally {
    rmTree(root);
  }
});

test("violation_over_threshold_is_reported_and_fails", async () => {
  const root = tmpRepo("crap-viol-");
  try {
    stageWithHunk(root, "foo.ts", "function f() {\n  return 1;\n}\n");
    amendLine(root, "foo.ts", "function f() {\n  return 2;\n}\n");

    const res = await runCrap({
      cwd: root,
      adapter: fakeAdapter({
        functions: [HIGH_CC_FN],
        snapshot: { files: { "foo.ts": { executed: [1], missing: [2, 3, 4, 5] } } },
      }),
    });

    assert.equal(res.status, 1);
    assert.match(res.stderr, /^crap: CRAP threshold exceeded \(threshold=10\):/);
    assert.match(res.stderr, /foo\.ts:f  CC=11  cov=20%  CRAP=\d+/);
  } finally {
    rmTree(root);
  }
});

test("function_not_intersecting_hunk_is_not_reported", async () => {
  const root = tmpRepo("crap-nohit-");
  try {
    stageWithHunk(root, "foo.ts", "function f() {\n  return 1;\n}\n\n\n\n\nconst x = 1;\n");
    amendLine(root, "foo.ts", "function f() {\n  return 1;\n}\n\n\n\n\nconst x = 2;\n");

    const res = await runCrap({
      cwd: root,
      adapter: fakeAdapter({
        functions: [HIGH_CC_FN],
        snapshot: { files: { "foo.ts": { executed: [], missing: [1, 2, 3] } } },
      }),
    });

    assert.equal(res.status, 0);
  } finally {
    rmTree(root);
  }
});

test("test_file_is_skipped_even_with_a_high_cc_function", async () => {
  const root = tmpRepo("crap-testskip-");
  try {
    stageWithHunk(root, "foo.test.ts", "function f() {\n  return 1;\n}\n");
    amendLine(root, "foo.test.ts", "function f() {\n  return 2;\n}\n");

    const res = await runCrap({ cwd: root, adapter: fakeAdapter({ functions: [HIGH_CC_FN] }) });

    assert.equal(res.status, 0);
  } finally {
    rmTree(root);
  }
});

test("declaration_file_is_skipped", async () => {
  const root = tmpRepo("crap-dts-");
  try {
    stageWithHunk(root, "types.d.ts", "declare const x: number;\n");
    amendLine(root, "types.d.ts", "declare const x: string;\n");

    const res = await runCrap({ cwd: root, adapter: fakeAdapter({ functions: [HIGH_CC_FN] }) });

    assert.equal(res.status, 0);
  } finally {
    rmTree(root);
  }
});

test("file_under_a_skipped_path_segment_is_skipped", async () => {
  const root = tmpRepo("crap-seg-");
  try {
    stageWithHunk(root, "scripts/run.ts", "function f() {\n  return 1;\n}\n");
    amendLine(root, "scripts/run.ts", "function f() {\n  return 2;\n}\n");

    const res = await runCrap({ cwd: root, adapter: fakeAdapter({ functions: [HIGH_CC_FN] }) });

    assert.equal(res.status, 0);
  } finally {
    rmTree(root);
  }
});

test("file_in_a_dot_directory_is_skipped", async () => {
  const root = tmpRepo("crap-dot-");
  try {
    stageWithHunk(root, ".cache/run.ts", "function f() {\n  return 1;\n}\n");
    amendLine(root, ".cache/run.ts", "function f() {\n  return 2;\n}\n");

    const res = await runCrap({ cwd: root, adapter: fakeAdapter({ functions: [HIGH_CC_FN] }) });

    assert.equal(res.status, 0);
  } finally {
    rmTree(root);
  }
});

test("generated_header_file_is_skipped", async () => {
  const root = tmpRepo("crap-gen-");
  try {
    const header = "// @generated\n// do not edit\nfunction f() {\n  return 1;\n}\n";
    stageWithHunk(root, "gen.ts", header);
    amendLine(root, "gen.ts", "// @generated\n// do not edit\nfunction f() {\n  return 2;\n}\n");

    const res = await runCrap({ cwd: root, adapter: fakeAdapter({ functions: [HIGH_CC_FN] }) });

    assert.equal(res.status, 0);
  } finally {
    rmTree(root);
  }
});

test("file_absent_from_snapshot_is_treated_as_new_with_zero_coverage", async () => {
  const root = tmpRepo("crap-new-");
  try {
    stageWithHunk(root, "foo.ts", "function f() {\n  return 1;\n}\n");
    amendLine(root, "foo.ts", "function f() {\n  return 2;\n}\n");

    const res = await runCrap({
      cwd: root,
      adapter: fakeAdapter({ functions: [HIGH_CC_FN], snapshot: { files: {} } }),
    });

    assert.equal(res.status, 1);
    assert.match(res.stderr, /cov=0%/);
  } finally {
    rmTree(root);
  }
});

test("threshold_is_configurable", async () => {
  const root = tmpRepo("crap-thresh-");
  try {
    stageWithHunk(root, "foo.ts", "function f() {\n  return 1;\n}\n");
    amendLine(root, "foo.ts", "function f() {\n  return 2;\n}\n");

    const lowCc: CrapFunction = { name: "f", startLine: 1, endLine: 5, cc: 2 };
    const res = await runCrap({
      cwd: root,
      threshold: 1,
      adapter: fakeAdapter({
        functions: [lowCc],
        snapshot: { files: { "foo.ts": { executed: [], missing: [1, 2, 3] } } },
      }),
    });

    assert.equal(res.status, 1);
    assert.match(res.stderr, /threshold=1\):/);
  } finally {
    rmTree(root);
  }
});
