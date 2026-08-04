import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import { pythonCrapAdapter } from "./coverage-python.ts";
import type { Snapshot } from "./coverage-v8.ts";

const COVERAGE_JSON_HEADER = `{"files": {"app/foo.py": {"executed_lines": [1, 2], "missing_lines": [3, 4, 5]}}}`;

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTree(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeFakeCoverageExecutable(dir: string, body: string, exitCode = 0): string {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, "coverage");
  fs.writeFileSync(exe, `#!/bin/sh\nprintf '%s' '${body.replace(/'/g, "'\\''")}'\nexit ${exitCode}\n`);
  fs.chmodSync(exe, 0o755);
  return binDir;
}

function makeCoverageAbsentDir(dir: string): string {
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  return binDir;
}

function touchDotCoverage(dir: string, mtimeSecondsAgo = 0): void {
  const dot = path.join(dir, ".coverage");
  fs.writeFileSync(dot, "");
  if (mtimeSecondsAgo > 0) {
    const atime = (Date.now() / 1000) - mtimeSecondsAgo;
    fs.utimesSync(dot, atime, atime);
  }
}

test("snapshot_exists_reports_dot_coverage_presence", () => {
  const dir = tmpDir("covpy-exists-");
  try {
    const adapter = pythonCrapAdapter(dir);

    assert.equal(adapter.snapshotExists(), false);

    touchDotCoverage(dir);
    assert.equal(adapter.snapshotExists(), true);
  } finally {
    rmTree(dir);
  }
});

test("snapshot_mtime_reads_dot_coverage_mtime", () => {
  const dir = tmpDir("covpy-mtime-");
  try {
    touchDotCoverage(dir, 3600);
    const adapter = pythonCrapAdapter(dir);

    const now = Date.now() / 1000;
    assert.ok(adapter.snapshotMtime() < now - 3500);
  } finally {
    rmTree(dir);
  }
});

test("load_snapshot_parses_coverage_json_into_file_lines", () => {
  const dir = tmpDir("covpy-load-");
  try {
    touchDotCoverage(dir);
    const binDir = makeFakeCoverageExecutable(dir, COVERAGE_JSON_HEADER);
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;

    try {
      const snapshot = pythonCrapAdapter(dir).loadSnapshot() as Snapshot;

      assert.deepEqual(snapshot.files["app/foo.py"], { executed: [1, 2], missing: [3, 4, 5] });
    } finally {
      process.env.PATH = oldPath;
    }
  } finally {
    rmTree(dir);
  }
});

test("load_snapshot_returns_clean_error_when_coverage_cli_is_absent", () => {
  const dir = tmpDir("covpy-nocli-");
  try {
    touchDotCoverage(dir);
    const binDir = makeCoverageAbsentDir(dir);
    const oldPath = process.env.PATH;
    process.env.PATH = binDir;

    try {
      const result = pythonCrapAdapter(dir).loadSnapshot();

      assert.ok(!("files" in result), "expected an error result, not a snapshot");
      assert.match((result as { error: string }).error, /coverage CLI not on PATH/i);
    } finally {
      process.env.PATH = oldPath;
    }
  } finally {
    rmTree(dir);
  }
});

test("load_snapshot_surfaces_stderr_detail_on_nonzero_exit", () => {
  const dir = tmpDir("covpy-fail-");
  try {
    touchDotCoverage(dir);
    const binDir = makeFakeCoverageExecutable(dir, "", 2);
    fs.writeFileSync(path.join(binDir, "coverage"), "#!/bin/sh\nprintf '%s\\n' 'boom: no source' >&2\nexit 2\n");
    fs.chmodSync(path.join(binDir, "coverage"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath}`;

    try {
      const result = pythonCrapAdapter(dir).loadSnapshot();

      assert.ok(!("files" in result));
      assert.match((result as { error: string }).error, /boom: no source/);
    } finally {
      process.env.PATH = oldPath;
    }
  } finally {
    rmTree(dir);
  }
});

const BRANCHING_PY = "def f(x):\n    if x:\n        return 1\n    elif x:\n        return 2\n    elif x:\n        return 3\n";

test("extract_functions_maps_python_extractor_facts_to_crap_functions", () => {
  const dir = tmpDir("covpy-extract-");
  try {
    const adapter = pythonCrapAdapter(dir);
    const functions = adapter.extractFunctions("app/foo.py", BRANCHING_PY);

    const f = functions.find((fn) => fn.name === "f");
    assert.ok(f !== undefined);
    assert.equal(f.startLine, 1);
    assert.ok(f.endLine >= f.startLine);
    assert.ok(f.cc > 1);
  } finally {
    rmTree(dir);
  }
});
