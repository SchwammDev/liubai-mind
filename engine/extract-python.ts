import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import type { CommentFacts, Extracted, Extractor, FunctionFacts } from "./contract.ts";

const SCRIPT_PATH = join(import.meta.dirname, "extract-python.py");
const PYTHON_BIN = join(import.meta.dirname, ".venv", "bin", "python");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChange(value: unknown): value is "new" | "changed" | "same" {
  return value === "new" || value === "changed" || value === "same";
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value !== "number") throw new Error(message);
  return value;
}

function requireBoolean(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") throw new Error(message);
  return value;
}

function requireStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((m) => typeof m !== "string")) throw new Error(message);
  return value as string[];
}

function requireChange(value: unknown, message: string): "new" | "changed" | "same" {
  if (!isChange(value)) throw new Error(message);
  return value;
}

function requireCommentKind(value: unknown, message: string): CommentFacts["kind"] {
  if (value !== "line" && value !== "doc" && value !== "block" && value !== "tooling") throw new Error(message);
  return value;
}

export function validateFunction(raw: unknown): FunctionFacts {
  if (!isObject(raw)) throw new Error("extract-python: function fact is not an object");
  return {
    name: requireString(raw.name, "extract-python: function name is not a string"),
    startLine: requireNumber(raw.startLine, "extract-python: function startLine is not a number"),
    cyclomaticComplexity: requireNumber(raw.cyclomaticComplexity, "extract-python: function cyclomaticComplexity is not a number"),
    missingAnnotations: requireStringArray(raw.missingAnnotations, "extract-python: function missingAnnotations is not a string array"),
    isTest: requireBoolean(raw.isTest, "extract-python: function isTest is not a boolean"),
    bodyLineCount: requireNumber(raw.bodyLineCount, "extract-python: function bodyLineCount is not a number"),
    signature: requireChange(raw.signature, "extract-python: function signature is not a Change"),
    body: requireChange(raw.body, "extract-python: function body is not a Change"),
  };
}

export function validateComment(raw: unknown): CommentFacts {
  if (!isObject(raw)) throw new Error("extract-python: comment fact is not an object");
  return {
    line: requireNumber(raw.line, "extract-python: comment line is not a number"),
    text: requireString(raw.text, "extract-python: comment text is not a string"),
    kind: requireCommentKind(raw.kind, "extract-python: comment kind is not a CommentFacts kind"),
    added: requireBoolean(raw.added, "extract-python: comment added is not a boolean"),
  };
}

function validateExtracted(raw: unknown): Extracted {
  if (!isObject(raw)) throw new Error("extract-python: output is not an object");
  const functions = raw.functions;
  const comments = raw.comments;
  if (!Array.isArray(functions)) throw new Error("extract-python: functions is not an array");
  if (!Array.isArray(comments)) throw new Error("extract-python: comments is not an array");
  return {
    functions: functions.map(validateFunction),
    comments: comments.map(validateComment),
  };
}

function runExtractorScript(payload: string): string {
  if (!existsSync(PYTHON_BIN)) {
    throw new Error(`extract-python: venv missing at ${PYTHON_BIN}; run \`./setup.sh\` (requires uv on PATH)`);
  }

  const res = spawnSync(PYTHON_BIN, [SCRIPT_PATH], { input: payload, encoding: "utf8" });

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

function parseExtractorOutput(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`extract-python: stdout is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const pythonExtractor: Extractor = {
  extract(input): Extracted {
    const payload = JSON.stringify({
      path: input.path,
      ...(input.before !== undefined ? { before: input.before } : {}),
      after: input.after,
    });

    return validateExtracted(parseExtractorOutput(runExtractorScript(payload)));
  },
};
