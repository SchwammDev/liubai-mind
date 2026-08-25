import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

import { PYTHON_BIN } from "../extract-python.ts";
import type { PyRunner } from "./silent-handlers.ts";

const require_ = createRequire(import.meta.url);

const PY_SCRIPT_PATH = join(import.meta.dirname, "scripts", "parse_check.py");

type RootNode = { hasError: boolean | (() => boolean) };

type TreeRootLike = { rootNode: RootNode };

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

function rootHasError(root: RootNode): boolean {
  const he = root.hasError;
  return typeof he === "function" ? he.call(root) : he === true;
}

export function sourceParsesTs(source: string): boolean {
  const language = loadLanguage();
  const ParserCtor = getParser();
  const parser = new ParserCtor();
  parser.setLanguage(language);
  const tree = parser.parse(source);

  return !rootHasError(tree.rootNode);
}

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

function parseParsedFlag(stdout: string): boolean {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || !("parsed" in parsed)) {
    throw new Error(`parse-check: unexpected python output: ${stdout}`);
  }
  const flag = (parsed as { parsed: unknown }).parsed;
  if (typeof flag !== "boolean") {
    throw new Error(`parse-check: parsed is not a boolean: ${stdout}`);
  }
  return flag;
}

export function sourceParsesPy(source: string, runPy: PyRunner = defaultPyRunner): boolean {
  const stdout = runPy(PY_SCRIPT_PATH, source);
  return parseParsedFlag(stdout);
}

export function sourceParses(source: string, lang: "typescript" | "python"): boolean {
  return lang === "typescript" ? sourceParsesTs(source) : sourceParsesPy(source);
}
