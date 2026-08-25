import { posix } from "node:path";

export interface ReferenceScan {
  referenced: string[];
  unresolved: string[];
}

export interface ScanReferencesInput {
  lang: "typescript" | "python";
  entry: string;
  files: Record<string, string>;
  created: readonly string[];
}

interface ScanState {
  lang: "typescript" | "python";
  entry: string;
  createdSet: Set<string>;
  visited: Set<string>;
  referenced: Set<string>;
  unresolved: Set<string>;
  queue: string[];
}

export function scanReferences(input: ScanReferencesInput): ReferenceScan {
  const { lang, entry, files, created } = input;

  if (files[entry] === undefined) {
    return { referenced: [], unresolved: [] };
  }

  const state: ScanState = {
    lang,
    entry,
    createdSet: new Set(created),
    visited: new Set([entry]),
    referenced: new Set(),
    unresolved: new Set(),
    queue: [entry],
  };

  while (state.queue.length > 0) {
    const current = state.queue.shift();
    if (current === undefined) continue;
    scanFile(current, files, state);
  }

  return {
    referenced: [...state.referenced].sort(),
    unresolved: [...state.unresolved].sort(),
  };
}

function scanFile(current: string, files: Record<string, string>, state: ScanState): void {
  const source = files[current];
  if (source === undefined) return;

  for (const spec of extractSpecifiers(state.lang, source)) {
    applySpecifier(current, spec, state);
  }
}

function applySpecifier(current: string, spec: string, state: ScanState): void {
  const candidates = resolveCandidates(state.lang, current, spec);
  if (candidates === undefined) return;

  const match = candidates.find((candidate) => state.createdSet.has(candidate));
  if (match !== undefined) {
    markReferenced(match, state);
    return;
  }

  markUnresolved(candidates, state);
}

function markReferenced(match: string, state: ScanState): void {
  state.referenced.add(match);
  if (state.visited.has(match)) return;
  state.visited.add(match);
  state.queue.push(match);
}

function markUnresolved(candidates: string[], state: ScanState): void {
  for (const candidate of candidates) {
    if (candidate !== state.entry) state.unresolved.add(candidate);
  }
}

function extractSpecifiers(lang: "typescript" | "python", source: string): string[] {
  return lang === "typescript" ? extractTsSpecifiers(source) : extractPySpecifiers(source);
}

function resolveCandidates(lang: "typescript" | "python", importerKey: string, spec: string): string[] | undefined {
  return lang === "typescript" ? resolveTsCandidates(importerKey, spec) : resolvePyCandidates(spec);
}

function stripTsComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*");
    })
    .join("\n");
}

function extractTsSpecifiers(source: string): string[] {
  const filtered = stripTsComments(source);
  const specifiers: string[] = [];

  for (const match of filtered.matchAll(/\bfrom\s*(["'])([^"']+)\1/g)) {
    specifiers.push(match[2]!);
  }

  for (const line of filtered.split("\n")) {
    const match = line.match(/^\s*import\s*(["'])([^"']+)\1/);
    if (match !== null) specifiers.push(match[2]!);
  }

  for (const match of filtered.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g)) {
    specifiers.push(match[2]!);
  }

  for (const match of filtered.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g)) {
    specifiers.push(match[2]!);
  }

  return specifiers;
}

function resolveTsCandidates(importerKey: string, spec: string): string[] | undefined {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return undefined;

  const resolved = posix.normalize(posix.join(posix.dirname(importerKey), spec));
  if (resolved.startsWith("../")) return undefined;

  if (resolved.endsWith(".ts") || resolved.endsWith(".js")) return [resolved];

  return [`${resolved}.ts`, `${resolved}.js`];
}

function stripPyComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const hashIndex = line.indexOf("#");
      return hashIndex === -1 ? line : line.slice(0, hashIndex);
    })
    .join("\n");
}

function extractPySpecifiers(source: string): string[] {
  const filtered = stripPyComments(source);
  const modules: string[] = [];

  for (const line of filtered.split("\n")) {
    const fromMatch = line.match(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/);
    if (fromMatch !== null) {
      modules.push(fromMatch[1]!);
      continue;
    }

    const importMatch = line.match(/^\s*import\s+(.+)$/);
    if (importMatch === null) continue;

    for (const piece of importMatch[1]!.split(",")) {
      const pieceMatch = piece.match(/^\s*([A-Za-z_][\w.]*)(?:\s+as\s+[A-Za-z_]\w*)?\s*$/);
      if (pieceMatch !== null) modules.push(pieceMatch[1]!);
    }
  }

  return modules;
}

function resolvePyCandidates(moduleName: string): string[] {
  const path = moduleName.replaceAll(".", "/");
  return [`${path}.py`, `${path}/__init__.py`];
}
