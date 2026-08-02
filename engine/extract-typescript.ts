import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createRequire } from "node:module";

import type { Change, CommentFacts, Extracted, Extractor, FunctionFacts } from "./contract.ts";

const require_ = createRequire(import.meta.url);

const QUERIES_PATH = join(import.meta.dirname, "queries", "typescript.scm");
const LIZARD_SCRIPT = join(import.meta.dirname, "lizard-cc.py");
const PYTHON_BIN = join(import.meta.dirname, ".venv", "bin", "python");

const QUERY_TEXT = readFileSync(QUERIES_PATH, "utf8");

const FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
]);

const TOOLING_RE =
  /@ts-(?:ignore|expect-error)|eslint-(?:disable|enable)(?:-next-line)?|istanbul ignore next|c8 ignore next|prettier-ignore|stylelint-disable|tslint:disable|jshint|jscs|jslint/i;

function isTestPath(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  const ext = "(ts|tsx|mts|cts)";
  return new RegExp(`(^|/)__tests__/[^/]+\\.${ext}$`).test(norm)
    || new RegExp(`\\.test\\.${ext}$`).test(norm)
    || new RegExp(`\\.spec\\.${ext}$`).test(norm);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChange(value: unknown): value is Change {
  return value === "new" || value === "changed" || value === "same";
}

export function validateFunction(raw: unknown): FunctionFacts {
  if (!isObject(raw)) throw new Error("extract-typescript: function fact is not an object");
  const name = raw.name;
  const startLine = raw.startLine;
  const cyclomaticComplexity = raw.cyclomaticComplexity;
  const missingAnnotations = raw.missingAnnotations;
  const isTest = raw.isTest;
  const bodyLineCount = raw.bodyLineCount;
  const signature = raw.signature;
  const body = raw.body;
  if (typeof name !== "string") throw new Error("extract-typescript: function name is not a string");
  if (typeof startLine !== "number") throw new Error("extract-typescript: function startLine is not a number");
  if (typeof cyclomaticComplexity !== "number") throw new Error("extract-typescript: function cyclomaticComplexity is not a number");
  if (!Array.isArray(missingAnnotations) || missingAnnotations.some((m) => typeof m !== "string")) {
    throw new Error("extract-typescript: function missingAnnotations is not a string array");
  }
  if (typeof isTest !== "boolean") throw new Error("extract-typescript: function isTest is not a boolean");
  if (typeof bodyLineCount !== "number") throw new Error("extract-typescript: function bodyLineCount is not a number");
  if (!isChange(signature)) throw new Error("extract-typescript: function signature is not a Change");
  if (!isChange(body)) throw new Error("extract-typescript: function body is not a Change");
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

export function validateComment(raw: unknown): CommentFacts {
  if (!isObject(raw)) throw new Error("extract-typescript: comment fact is not an object");
  const line = raw.line;
  const text = raw.text;
  const kind = raw.kind;
  const added = raw.added;
  if (typeof line !== "number") throw new Error("extract-typescript: comment line is not a number");
  if (typeof text !== "string") throw new Error("extract-typescript: comment text is not a string");
  if (kind !== "line" && kind !== "doc" && kind !== "block" && kind !== "tooling") {
    throw new Error("extract-typescript: comment kind is not a CommentFacts kind");
  }
  if (typeof added !== "boolean") throw new Error("extract-typescript: comment added is not a boolean");
  return { line, text, kind, added };
}

function validateExtracted(raw: Extracted): Extracted {
  const functions = raw.functions;
  const comments = raw.comments;
  if (!Array.isArray(functions)) throw new Error("extract-typescript: functions is not an array");
  if (!Array.isArray(comments)) throw new Error("extract-typescript: comments is not an array");
  return {
    functions: functions.map(validateFunction),
    comments: comments.map(validateComment),
  };
}

type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  childForFieldName(name: string): TSNode | null;
  namedChildren: TSNode[];
  parent: TSNode | null;
};

type TreeRootLike = { rootNode: TSNode; hasError?: () => boolean };

function loadLanguage(ext: string): unknown {
  const ts = require_("tree-sitter-typescript");
  return ext === ".tsx" ? ts.tsx : ts.typescript;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _Parser: any;
function getParser(): { new (): { setLanguage(language: unknown): void; parse(input: string): TreeRootLike } } {
  if (_Parser === undefined) {
    _Parser = require_("tree-sitter");
  }
  return _Parser;
}

type QueryLike = { matches(node: TSNode): { captures: { name: string; node: TSNode }[] }[]; captures(node: TSNode): { name: string; node: TSNode }[] };

const _queries = new Map<unknown, QueryLike>();

function newQuery(language: unknown): QueryLike {
  let q = _queries.get(language);
  if (q === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ParserClass: any = getParser();
    q = new ParserClass.Query(language, QUERY_TEXT) as QueryLike;
    _queries.set(language, q);
  }
  return q;
}

function firstStringArg(args: TSNode): TSNode | null {
  for (const child of args.namedChildren) {
    if (child.type === "string") return child;
  }
  return null;
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const head = s.charAt(0);
    const tail = s.charAt(s.length - 1);
    if ((head === "'" || head === '"') && tail === head) return s.slice(1, -1);
  }
  return s;
}

function isLastNamedChild(parent: TSNode, node: TSNode): boolean {
  const children = parent.namedChildren;
  if (children.length === 0) return false;
  return children[children.length - 1] === node;
}

function resolveTestDescription(node: TSNode): string {
  const args = node.parent;
  if (args !== null && args.type === "arguments") {
    const first = firstStringArg(args);
    if (first !== null) return unquote(first.text);
  }
  return "anonymous";
}

function bodyNodeOf(node: TSNode): TSNode | null {
  const body = node.childForFieldName("body");
  return body;
}

function bodyLineCountOf(body: TSNode | null): number {
  if (body === null) return 1;
  if (body.type === "statement_block") {
    const children = body.namedChildren;
    if (children.length === 0) return 1;
    const first = children[0]!;
    const last = children[children.length - 1]!;
    return last.endPosition.row - first.startPosition.row + 1;
  }
  return body.endPosition.row - body.startPosition.row + 1;
}

function signatureRegion(src: string, node: TSNode, body: TSNode | null): string {
  if (body !== null) return src.slice(node.startIndex, body.startIndex);
  return node.text;
}

function bodyRegion(src: string, body: TSNode | null): string {
  return body !== null ? src.slice(body.startIndex, body.endIndex) : "";
}

type BeforeFunctions = Map<string, { signature: string; body: string }>;

function loadLanguageForPath(path: string): unknown {
  const lower = path.toLowerCase();
  let ext = ".ts";
  if (lower.endsWith(".tsx")) ext = ".tsx";
  else if (lower.endsWith(".mts")) ext = ".ts";
  else if (lower.endsWith(".cts")) ext = ".ts";
  return loadLanguage(ext);
}

function parseSource(language: unknown, src: string): TreeRootLike | null {
  const ParserCtor = getParser();
  const parser = new ParserCtor();
  parser.setLanguage(language);
  const tree = parser.parse(src) as unknown as TreeRootLike;
  const root = tree;
  if (typeof root.hasError === "function" ? root.hasError() : false) return null;
  return root;
}

function beforeFunctionRegions(language: unknown, before: string | undefined): BeforeFunctions {
  if (before === undefined) return new Map();
  const root = parseSource(language, before);
  if (root === null) return new Map();
  const q = newQuery(language);
  const out: BeforeFunctions = new Map();
  for (const cap of q.captures(root.rootNode)) {
    if (cap.name !== "function") continue;
    if (!FUNCTION_NODE_TYPES.has(cap.node.type)) continue;
    const body = bodyNodeOf(cap.node);
    const nameField = cap.node.childForFieldName("name");
    out.set(nameField === null ? "anonymous" : nameField.text, {
      signature: signatureRegion(before, cap.node, body),
      body: bodyRegion(before, body),
    });
  }
  return out;
}

function lizardCcMap(path: string, after: string): Map<string, number> {
  if (!existsSync(PYTHON_BIN)) {
    throw new Error(`extract-typescript: venv missing at ${PYTHON_BIN}; run \`./setup.sh\` (requires uv on PATH)`);
  }
  const res = spawnSync(PYTHON_BIN, [LIZARD_SCRIPT], {
    input: JSON.stringify({ path, after }),
    encoding: "utf8",
  });
  if (res.error !== undefined) throw new Error(res.error.message);
  if (res.status !== 0) {
    const stderrLines = (res.stderr ?? "").split("\n").filter((s) => s.length > 0);
    const last = stderrLines[stderrLines.length - 1];
    throw new Error(last ?? `extract-typescript: lizard exit ${res.status}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    throw new Error(`extract-typescript: lizard stdout is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(parsed) || !Array.isArray(parsed.functions)) return new Map();
  const out = new Map<string, number>();
  for (const f of parsed.functions) {
    if (isObject(f) && typeof f.name === "string" && typeof f.startLine === "number" && typeof f.cyclomaticComplexity === "number") {
      out.set(`${f.name}:${f.startLine}`, f.cyclomaticComplexity);
    }
  }
  return out;
}

function commentFacts(after: string, before: string | undefined, root: TSNode, language: unknown): CommentFacts[] {
  const afterLines = after.split("\n");
  const beforeLines = new Set((before ?? "").split("\n"));
  const q = newQuery(language);
  const facts: CommentFacts[] = [];
  for (const cap of q.captures(root)) {
    if (cap.name !== "comment") continue;
    if (cap.node.type !== "comment") continue;
    const isBlock = cap.node.text.startsWith("/*");
    const isDoc = isBlock && cap.node.text.startsWith("/**");
    const startRow = cap.node.startPosition.row + 1;
    const endRow = cap.node.endPosition.row + 1;
    for (let line = startRow; line <= endRow; line++) {
      const text = afterLines[line - 1] ?? "";
      const kind: CommentFacts["kind"] = TOOLING_RE.test(text)
        ? "tooling"
        : isBlock
          ? isDoc
            ? "doc"
            : "block"
          : "line";
      facts.push({ line, text, kind, added: !beforeLines.has(text) });
    }
  }
  return facts;
}

function functionFacts(
  root: TSNode,
  language: unknown,
  path: string,
  after: string,
  before: string | undefined,
  lizardMap: Map<string, number>,
): FunctionFacts[] {
  const beforeFuncs = beforeFunctionRegions(language, before);
  const testPath = isTestPath(path);
  const seen = new Set<number>();
  const functions: TSNode[] = [];

  const q = newQuery(language);
  const testNodes = new Set<number>();
  for (const cap of q.captures(root)) {
    if (cap.name !== "testFunction") continue;
    if (!FUNCTION_NODE_TYPES.has(cap.node.type)) continue;
    const parent = cap.node.parent;
    if (parent === null || parent.type !== "arguments") continue;
    if (!isLastNamedChild(parent, cap.node)) continue;
    testNodes.add(cap.node.startIndex);
  }

  for (const cap of q.captures(root)) {
    if (cap.name !== "function") continue;
    if (!FUNCTION_NODE_TYPES.has(cap.node.type)) continue;
    const idx = cap.node.startIndex;
    if (seen.has(idx)) continue;
    seen.add(idx);
    functions.push(cap.node);
  }

  return functions.map((node) => {
    const body = bodyNodeOf(node);
    const isTestCallback = testNodes.has(node.startIndex);

    let name: string;
    const nameField = node.childForFieldName("name");
    if (nameField !== null) {
      name = nameField.text;
    } else {
      name = isTestCallback && testPath ? resolveTestDescription(node) : "anonymous";
    }

    const startLine = node.startPosition.row + 1;
    const cc = lizardMap.get(`${name}:${startLine}`) ?? 1;

    const bodyLineCount = bodyLineCountOf(body);

    const sigAfter = signatureRegion(after, node, body);
    const bodyAfter = bodyRegion(after, body);

    let signature: Change;
    let bodyChange: Change;
    const prev = beforeFuncs.get(name);
    if (prev === undefined) {
      signature = "new";
      bodyChange = "new";
    } else {
      signature = sigAfter === prev.signature ? "same" : "changed";
      bodyChange = bodyAfter === prev.body ? "same" : "changed";
    }

    return {
      name,
      startLine,
      cyclomaticComplexity: cc,
      missingAnnotations: [],
      isTest: testPath && isTestCallback,
      bodyLineCount,
      signature,
      body: bodyChange,
    } satisfies FunctionFacts;
  });
}

function extractRaw(input: { path: string; before?: string; after: string }): Extracted {
  const language = loadLanguageForPath(input.path);
  const root = parseSource(language, input.after);
  if (root === null) return { functions: [], comments: [] };
  const lizardMap = lizardCcMap(input.path, input.after);
  const functions = functionFacts(root.rootNode, language, input.path, input.after, input.before, lizardMap);
  const comments = commentFacts(input.after, input.before, root.rootNode, language);
  return { functions, comments };
}

export const typescriptExtractor: Extractor = {
  extract(input): Extracted {
    return validateExtracted(extractRaw(input));
  },
};