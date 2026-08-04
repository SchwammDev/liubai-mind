import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { pythonExtractor } from "./extract-python.ts";
import type { CrapAdapter, SnapshotLoad } from "./crap-cli.ts";
import type { Snapshot } from "./coverage-v8.ts";

const DOT_COVERAGE = ".coverage";
const MISSING_CLI_MSG = "crap: coverage CLI not on PATH — install with `uv tool install coverage` or activate the project venv.";

interface CoverageJsonFile {
  executed_lines: number[];
  missing_lines: number[];
}

interface CoverageJson {
  files: Record<string, CoverageJsonFile>;
}

function isFileEntry(value: unknown): value is CoverageJsonFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.executed_lines) && Array.isArray(v.missing_lines)
    && v.executed_lines.every((n) => typeof n === "number")
    && v.missing_lines.every((n) => typeof n === "number");
}

function parseCoverageJson(stdout: string): Snapshot {
  const parsed = JSON.parse(stdout) as Partial<CoverageJson>;
  const files = parsed.files ?? {};
  const snapshot: Snapshot = { files: {} };
  for (const [rel, entry] of Object.entries(files)) {
    if (!isFileEntry(entry)) continue;
    snapshot.files[rel] = { executed: entry.executed_lines, missing: entry.missing_lines };
  }
  return snapshot;
}

export function pythonCrapAdapter(cwd: string): CrapAdapter {
  const dotCoverage = join(cwd, DOT_COVERAGE);

  return {
    snapshotExists: () => existsSync(dotCoverage),
    snapshotMtime: () => statSync(dotCoverage).mtimeMs / 1000,

    loadSnapshot: (): SnapshotLoad => {
      const res = spawnSync("coverage", ["json", "-o", "-"], { cwd, encoding: "utf8" });

      if (res.error !== undefined && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
        return { error: MISSING_CLI_MSG };
      }
      if (res.status !== 0) {
        const detail = (res.stderr ?? "").trim() || `exit ${res.status}`;
        return { error: `crap: \`coverage json\` failed: ${detail}` };
      }
      return parseCoverageJson(res.stdout);
    },

    extractFunctions: (_filePath, source) => {
      const extracted = pythonExtractor.extract({ path: _filePath, after: source });
      if (extracted instanceof Promise) throw new Error("coverage-python: async extractor unsupported");
      return extracted.functions.map((f) => ({
        name: f.name,
        startLine: f.startLine,
        endLine: f.endLine,
        cc: f.cyclomaticComplexity,
      }));
    },
  };
}
