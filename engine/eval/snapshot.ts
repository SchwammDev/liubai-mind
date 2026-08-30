import { readdirSync, lstatSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";

export const SNAPSHOT_FILE_CAP_BYTES = 64 * 1024;
export const SNAPSHOT_TOTAL_CAP_BYTES = 512 * 1024;

export interface WorkDirSnapshot {
  files: Record<string, string>;
  dropped: string[];
}

const IGNORED_DIRS = new Set([
  "__pycache__",
  "node_modules",
  ".git",
  ".venv",
  "venv",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "dist",
  "build",
  ".cache",
  ".liubai",
]);

function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

function sortedEntries(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function collapseDropped(paths: string[]): string[] {
  const collapsed = paths.map((path) => {
    const slashIndex = path.indexOf("/");
    return slashIndex === -1 ? path : `${path.slice(0, slashIndex)}/`;
  });
  return [...new Set(collapsed)].sort();
}

interface WalkState {
  declared: ReadonlySet<string>;
  files: Record<string, string>;
  droppedRaw: string[];
  used: number;
}

function relPathOf(prefix: string, name: string): string {
  return prefix === "" ? name : `${prefix}/${name}`;
}

function captureFile(state: WalkState, fullPath: string, relPath: string): void {
  const size = lstatSync(fullPath).size;
  if (size > SNAPSHOT_FILE_CAP_BYTES) {
    state.droppedRaw.push(relPath);
    return;
  }

  const buffer = readFileSync(fullPath);
  if (buffer.includes(0)) {
    state.droppedRaw.push(relPath);
    return;
  }

  if (state.used + buffer.byteLength > SNAPSHOT_TOTAL_CAP_BYTES) {
    state.droppedRaw.push(relPath);
    return;
  }

  state.files[relPath] = buffer.toString("utf8");
  state.used += buffer.byteLength;
}

function visitEntry(state: WalkState, dir: string, entry: Dirent, relPrefix: string): void {
  const relPath = relPathOf(relPrefix, entry.name);
  const fullPath = join(dir, entry.name);

  if (entry.isSymbolicLink()) {
    state.droppedRaw.push(relPath);
    return;
  }

  if (entry.isDirectory()) {
    if (isIgnoredDir(entry.name)) return;
    walk(state, fullPath, relPath);
    return;
  }

  if (!entry.isFile()) return;
  if (state.declared.has(relPath)) return;
  if (entry.name.endsWith(".pyc")) return;

  captureFile(state, fullPath, relPath);
}

function walk(state: WalkState, dir: string, relPrefix: string): void {
  for (const entry of sortedEntries(dir)) {
    visitEntry(state, dir, entry, relPrefix);
  }
}

export function snapshotExtras(workDir: string, declared: ReadonlySet<string>): WorkDirSnapshot {
  const state: WalkState = { declared, files: {}, droppedRaw: [], used: 0 };
  walk(state, workDir, "");
  return { files: state.files, dropped: collapseDropped(state.droppedRaw) };
}
