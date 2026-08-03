import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import url from "node:url";
import { spawnSync } from "node:child_process";

import { v8CoverageToSnapshot } from "./coverage-v8.ts";
import type { Snapshot } from "./coverage-v8.ts";

const IF_BRANCH_SOURCE =
  "function f(x: number): number {\n" +
  "  if (x > 0) {\n" +
  "    return x;\n" +
  "  }\n" +
  "  return 0;\n" +
  "}\n";

const IF_STARTS = startsOf(IF_BRANCH_SOURCE);

const INTEGRATION_FIXTURE =
  "function covered(x: number): number {\n" +
  "  if (x > 0) {\n" +
  "    return x;\n" +
  "  }\n" +
  "  return 0;\n" +
  "}\n\n" +
  "function untouched(): number {\n" +
  "  return 42;\n" +
  "}\n\n" +
  "export { covered, untouched };\n";

const INTEGRATION_TEST = [
  "import { test } from \"node:test\";",
  "import assert from \"node:assert/strict\";",
  "import { covered, untouched } from \"./fixture.ts\";",
  "test(\"calls covered positive\", () => { assert.equal(covered(5), 5); });",
  "test(\"calls untouched\", () => { assert.equal(untouched(), 42); });",
].join("\n");

interface CraftedRange { startOffset: number; endOffset: number; count: number }
interface SrcFile { relPath: string; src: string; ranges: CraftedRange[] }

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeSource(root: string, relPath: string, content: string): string {
  const abs = path.join(root, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function startsOf(src: string): number[] {
  const starts = [0, 0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function pos(starts: number[], line: number, col: number): number {
  return starts[line]! + col;
}

function fnRange(count: number): CraftedRange {
  return { startOffset: pos(IF_STARTS, 1, 0), endOffset: pos(IF_STARTS, 6, 1), count };
}

function ifBranchRange(count: number): CraftedRange {
  return { startOffset: pos(IF_STARTS, 2, 13), endOffset: pos(IF_STARTS, 4, 3), count };
}

function fileUrl(absPath: string): string {
  return url.pathToFileURL(absPath).href;
}

function writeRepoCoverage(root: string, files: SrcFile[], coverageFile: string): void {
  const entries = files.map((f) => ({ url: fileUrl(writeSource(root, f.relPath, f.src)), ranges: f.ranges }));
  writeCoverage(path.join(root, "coverage"), coverageFile, entries);
}

function writeCoverage(coverageDir: string, file: string, entries: { url: string; ranges: CraftedRange[] }[]): void {
  fs.mkdirSync(coverageDir, { recursive: true });
  const doc = {
    result: entries.map((e) => ({
      url: e.url,
      functions: e.ranges.map((r) => ({
        functionName: "",
        ranges: [{ startOffset: r.startOffset, endOffset: r.endOffset, count: r.count }],
        isBlockCoverage: true,
      })),
    })),
  };
  fs.writeFileSync(path.join(coverageDir, file), JSON.stringify(doc));
}

async function snapshotOf(root: string): Promise<Snapshot> {
  return v8CoverageToSnapshot(path.join(root, "coverage"), root);
}

async function fileLines(snap: Promise<Snapshot> | Snapshot, relPath: string): Promise<{ executed: number[]; missing: number[] }> {
  const resolved = snap instanceof Promise ? await snap : snap;
  const f = resolved.files[relPath];
  if (f === undefined) assert.fail(`expected file ${relPath} in snapshot`);
  return f;
}

test("an untaken if-branch is missing while the rest of the function is executed", async () => {
  const root = tmpDir("v8cov-override-");
  try {
    writeRepoCoverage(root, [{ relPath: "cov.ts", src: IF_BRANCH_SOURCE, ranges: [fnRange(1), ifBranchRange(0)] }], "proc-1.json");

    assert.deepEqual(await fileLines(snapshotOf(root), "cov.ts"), { executed: [1, 2, 4, 5, 6], missing: [3] });
  } finally {
    rmTree(root);
  }
});

test("counts are summed across process coverage files so a branch taken in one is executed", async () => {
  const root = tmpDir("v8cov-merge-");
  try {
    writeRepoCoverage(root, [{ relPath: "cov.ts", src: IF_BRANCH_SOURCE, ranges: [fnRange(1), ifBranchRange(0)] }], "proc-1.json");
    writeRepoCoverage(root, [{ relPath: "cov.ts", src: IF_BRANCH_SOURCE, ranges: [fnRange(1), ifBranchRange(1)] }], "proc-2.json");

    assert.deepEqual(await fileLines(snapshotOf(root), "cov.ts"), { executed: [1, 2, 3, 4, 5, 6], missing: [] });
  } finally {
    rmTree(root);
  }
});

test("a range spanning partial lines maps to every line it touches", async () => {
  const root = tmpDir("v8cov-offset-");
  try {
    const src = "aaaaa\nbbbbbb\ncccccc\nddddd\n";
    const starts = startsOf(src);
    const ranges = [{ startOffset: pos(starts, 2, 2), endOffset: pos(starts, 4, 1), count: 1 }];
    writeRepoCoverage(root, [{ relPath: "cov.ts", src, ranges }], "proc-1.json");

    assert.deepEqual(await fileLines(snapshotOf(root), "cov.ts"), { executed: [2, 3, 4], missing: [] });
  } finally {
    rmTree(root);
  }
});

test("an uncalled function is entirely missing rather than skipped", async () => {
  const root = tmpDir("v8cov-uncalled-");
  try {
    writeRepoCoverage(root, [{ relPath: "cov.ts", src: IF_BRANCH_SOURCE, ranges: [fnRange(0)] }], "proc-1.json");

    assert.deepEqual(await fileLines(snapshotOf(root), "cov.ts"), { executed: [], missing: [1, 2, 3, 4, 5, 6] });
  } finally {
    rmTree(root);
  }
});

test("files are keyed by repo-relative posix path", async () => {
  const root = tmpDir("v8cov-relpath-");
  try {
    writeRepoCoverage(root, [{ relPath: "src/mod/cov.ts", src: IF_BRANCH_SOURCE, ranges: [fnRange(1)] }], "proc-1.json");

    const snap = await snapshotOf(root);

    assert.deepEqual(Object.keys(snap.files), ["src/mod/cov.ts"]);
    assert.deepEqual(snap.files["src/mod/cov.ts"], { executed: [1, 2, 3, 4, 5, 6], missing: [] });
  } finally {
    rmTree(root);
  }
});

test("files under node_modules are excluded", async () => {
  const root = tmpDir("v8cov-nodemod-");
  try {
    writeRepoCoverage(root, [
      { relPath: "cov.ts", src: IF_BRANCH_SOURCE, ranges: [fnRange(1)] },
      { relPath: "node_modules/pkg/cov.ts", src: IF_BRANCH_SOURCE, ranges: [fnRange(1)] },
    ], "proc-1.json");

    assert.deepEqual(Object.keys((await snapshotOf(root)).files), ["cov.ts"]);
  } finally {
    rmTree(root);
  }
});

test("files outside the repo root are excluded", async () => {
  const root = tmpDir("v8cov-outside-");
  try {
    const outsideRoot = path.join(root, "..", "v8cov-sibling-" + Date.now());
    fs.mkdirSync(outsideRoot, { recursive: true });
    const outside = writeSource(outsideRoot, "outside.ts", IF_BRANCH_SOURCE);
    writeCoverage(path.join(root, "coverage"), "proc-1.json", [
      { url: fileUrl(outside), ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] },
    ]);

    assert.deepEqual((await snapshotOf(root)).files, {});
  } finally {
    rmTree(root);
  }
});

test("executed and missing line arrays are sorted ascending", async () => {
  const root = tmpDir("v8cov-sorted-");
  try {
    const src = "a\nb\nc\nd\ne\n";
    const starts = startsOf(src);
    const ranges = [
      { startOffset: pos(starts, 4, 0), endOffset: pos(starts, 4, 1), count: 1 },
      { startOffset: pos(starts, 1, 0), endOffset: pos(starts, 1, 1), count: 1 },
      { startOffset: pos(starts, 5, 0), endOffset: pos(starts, 5, 1), count: 0 },
      { startOffset: pos(starts, 2, 0), endOffset: pos(starts, 2, 1), count: 0 },
    ];
    writeRepoCoverage(root, [{ relPath: "cov.ts", src, ranges }], "proc-1.json");

    assert.deepEqual(await fileLines(snapshotOf(root), "cov.ts"), { executed: [1, 4], missing: [2, 5] });
  } finally {
    rmTree(root);
  }
});

test("a file url pointing at a non-existent path under root is skipped not crashed", async () => {
  const root = tmpDir("v8cov-phantom-");
  try {
    const phantom = path.join(root, "[eval1]");
    writeCoverage(path.join(root, "coverage"), "proc-1.json", [
      { url: fileUrl(phantom), ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] },
    ]);

    const snap = await snapshotOf(root);

    assert.deepEqual(snap.files, {});
  } finally {
    rmTree(root);
  }
});

test("a real node --test subprocess produces a snapshot marking the untaken branch missing", async () => {
  const root = tmpDir("v8cov-integ-");
  try {
    writeSource(root, "fixture.ts", INTEGRATION_FIXTURE);
    writeSource(root, "fixture.test.ts", INTEGRATION_TEST);
    const snap = await runCoverageSnapshot(root);

    assert.deepEqual(snap.files["fixture.ts"], { executed: [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12], missing: [5] });
  } finally {
    rmTree(root);
  }
});

async function runCoverageSnapshot(root: string): Promise<Snapshot> {
  const coverageDir = path.join(root, "coverage");
  fs.mkdirSync(coverageDir, { recursive: true });
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  childEnv.NODE_V8_COVERAGE = coverageDir;
  const run = spawnSync(process.execPath, ["--test", "--experimental-strip-types", "fixture.test.ts"], {
    cwd: root,
    env: childEnv,
  });
  if (run.status !== 0) assert.fail(`node --test failed: ${run.stderr.toString()}`);
  return v8CoverageToSnapshot(coverageDir, root);
}
