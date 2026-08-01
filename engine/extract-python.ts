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

function validateFunction(raw: unknown): FunctionFacts {
  if (!isObject(raw)) throw new Error("extract-python: function fact is not an object");
  const name = raw.name;
  const startLine = raw.startLine;
  const cyclomaticComplexity = raw.cyclomaticComplexity;
  const missingAnnotations = raw.missingAnnotations;
  const isTest = raw.isTest;
  const bodyLineCount = raw.bodyLineCount;
  const signature = raw.signature;
  const body = raw.body;
  if (typeof name !== "string") throw new Error("extract-python: function name is not a string");
  if (typeof startLine !== "number") throw new Error("extract-python: function startLine is not a number");
  if (typeof cyclomaticComplexity !== "number") throw new Error("extract-python: function cyclomaticComplexity is not a number");
  if (!Array.isArray(missingAnnotations) || missingAnnotations.some((m) => typeof m !== "string")) {
    throw new Error("extract-python: function missingAnnotations is not a string array");
  }
  if (typeof isTest !== "boolean") throw new Error("extract-python: function isTest is not a boolean");
  if (typeof bodyLineCount !== "number") throw new Error("extract-python: function bodyLineCount is not a number");
  if (!isChange(signature)) throw new Error("extract-python: function signature is not a Change");
  if (!isChange(body)) throw new Error("extract-python: function body is not a Change");
  return {
    name,
    startLine,
    cyclomaticComplexity,
    missingAnnotations: missingAnnotations as string[],
    isTest,
    bodyLineCount,
    signature,
    body,
  };
}

function validateComment(raw: unknown): CommentFacts {
  if (!isObject(raw)) throw new Error("extract-python: comment fact is not an object");
  const line = raw.line;
  const text = raw.text;
  const kind = raw.kind;
  const added = raw.added;
  if (typeof line !== "number") throw new Error("extract-python: comment line is not a number");
  if (typeof text !== "string") throw new Error("extract-python: comment text is not a string");
  if (kind !== "line" && kind !== "doc" && kind !== "block" && kind !== "tooling") {
    throw new Error("extract-python: comment kind is not a CommentFacts kind");
  }
  if (typeof added !== "boolean") throw new Error("extract-python: comment added is not a boolean");
  return { line, text, kind, added };
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

export const pythonExtractor: Extractor = {
  extract(input): Extracted {
    const payload = JSON.stringify({
      path: input.path,
      ...(input.before !== undefined ? { before: input.before } : {}),
      after: input.after,
    });

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

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (err) {
      throw new Error(`extract-python: stdout is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    return validateExtracted(parsed);
  },
};
