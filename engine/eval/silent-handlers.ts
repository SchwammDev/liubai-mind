import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

import { PYTHON_BIN } from "../extract-python.ts";

const require_ = createRequire(import.meta.url);

const QUERIES_PATH = join(import.meta.dirname, "queries", "silent-handler.scm");

const QUERY_TEXT = readFileSync(QUERIES_PATH, "utf8");

const PY_SCRIPT_PATH = join(import.meta.dirname, "scripts", "silent_handlers.py");

type TSNode = {
  type: string;
  namedChildren: TSNode[];
};

type TreeRootLike = { rootNode: TSNode };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _Parser: any;
function getParser(): { new (): { setLanguage(language: unknown): void; parse(input: string): TreeRootLike } } {
  if (_Parser === undefined) {
    _Parser = require_("tree-sitter");
  }
  return _Parser;
}

function loadLanguage(): unknown {
  const ts = require_("tree-sitter-typescript");
  return ts.typescript;
}

type QueryLike = { captures(node: TSNode): { name: string; node: TSNode }[] };

let _query: QueryLike | undefined;
function getQuery(language: unknown): QueryLike {
  if (_query === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ParserClass: any = getParser();
    _query = new ParserClass.Query(language, QUERY_TEXT) as QueryLike;
  }
  return _query;
}

function subtreeHasThrowOrCall(node: TSNode): boolean {
  if (node.type === "throw_statement" || node.type === "call_expression") return true;
  return node.namedChildren.some(subtreeHasThrowOrCall);
}

export function countSilentHandlersTs(source: string): number {
  const language = loadLanguage();
  const ParserCtor = getParser();
  const parser = new ParserCtor();
  parser.setLanguage(language);
  const tree = parser.parse(source);

  const query = getQuery(language);
  let count = 0;
  for (const cap of query.captures(tree.rootNode)) {
    if (cap.name !== "catch") continue;
    if (!subtreeHasThrowOrCall(cap.node)) count += 1;
  }
  return count;
}

export type PyRunner = (script: string, source: string) => string;

function defaultPyRunner(script: string, source: string): string {
  const res = spawnSync(PYTHON_BIN, [script], { input: source, encoding: "utf8" });

  if (res.error !== undefined) {
    throw new Error(res.error.message);
  }

  if (res.status !== 0) {
    const stderrLines = (res.stderr ?? "").split("\n").filter((s) => s.length > 0);
    const last = stderrLines[stderrLines.length - 1];
    throw new Error(last ?? `exit ${res.status}`);
  }

  return res.stdout;
}

function parseCount(stdout: string): number {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || !("count" in parsed)) {
    throw new Error(`silent-handlers: unexpected python output: ${stdout}`);
  }
  const count = (parsed as { count: unknown }).count;
  if (typeof count !== "number") {
    throw new Error(`silent-handlers: count is not a number: ${stdout}`);
  }
  return count;
}

export function countSilentHandlersPy(source: string, runPy: PyRunner = defaultPyRunner): number {
  const stdout = runPy(PY_SCRIPT_PATH, source);
  return parseCount(stdout);
}

export function countSilentHandlers(source: string, lang: "typescript" | "python"): number {
  return lang === "typescript" ? countSilentHandlersTs(source) : countSilentHandlersPy(source);
}
