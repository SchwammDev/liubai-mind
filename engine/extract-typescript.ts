import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import type { Change, CommentFacts, Extracted, Extractor, FunctionFacts } from "./contract.ts";

const require_ = createRequire(import.meta.url);

const QUERIES_PATH = join(import.meta.dirname, "queries", "typescript.scm");

const QUERY_TEXT = readFileSync(QUERIES_PATH, "utf8");

const FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
  "generator_function",
]);

const CC_DECISION_NODE_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "catch_clause",
  "switch_case",
]);

const CC_LOGICAL_OPERATORS = new Set([
  "&&",
  "||",
  "??",
  "&&=",
  "||=",
  "??=",
]);

function operatorOf(node: TSNode): TSNode | null {
  return node.childForFieldName("operator");
}

function isDecisionNode(node: TSNode): boolean {
  if (CC_DECISION_NODE_TYPES.has(node.type)) return true;
  if (node.type === "ternary_expression") return true;
  if (node.type === "binary_expression" || node.type === "augmented_assignment_expression") {
    const op = operatorOf(node);
    if (op !== null && CC_LOGICAL_OPERATORS.has(op.text)) return true;
  }
  return false;
}

function cyclomaticComplexityWithin(functionNode: TSNode): number {
  let count = 1;
  const visit = (node: TSNode, isRoot: boolean): void => {
    if (!isRoot && FUNCTION_NODE_TYPES.has(node.type)) return;
    if (isDecisionNode(node)) count += 1;
    for (const child of node.namedChildren) visit(child, false);
  };
  visit(functionNode, true);
  return count;
}

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

function requireChange(value: unknown, message: string): Change {
  if (!isChange(value)) throw new Error(message);
  return value;
}

function requireCommentKind(value: unknown, message: string): CommentFacts["kind"] {
  if (value !== "line" && value !== "doc" && value !== "block" && value !== "tooling") throw new Error(message);
  return value;
}

export function validateFunction(raw: unknown): FunctionFacts {
  if (!isObject(raw)) throw new Error("extract-typescript: function fact is not an object");
  return {
    name: requireString(raw.name, "extract-typescript: function name is not a string"),
    startLine: requireNumber(raw.startLine, "extract-typescript: function startLine is not a number"),
    cyclomaticComplexity: requireNumber(raw.cyclomaticComplexity, "extract-typescript: function cyclomaticComplexity is not a number"),
    missingAnnotations: requireStringArray(raw.missingAnnotations, "extract-typescript: function missingAnnotations is not a string array"),
    isTest: requireBoolean(raw.isTest, "extract-typescript: function isTest is not a boolean"),
    bodyLineCount: requireNumber(raw.bodyLineCount, "extract-typescript: function bodyLineCount is not a number"),
    endLine: requireNumber(raw.endLine, "extract-typescript: function endLine is not a number"),
    signature: requireChange(raw.signature, "extract-typescript: function signature is not a Change"),
    body: requireChange(raw.body, "extract-typescript: function body is not a Change"),
  };
}

export function validateComment(raw: unknown): CommentFacts {
  if (!isObject(raw)) throw new Error("extract-typescript: comment fact is not an object");
  return {
    line: requireNumber(raw.line, "extract-typescript: comment line is not a number"),
    text: requireString(raw.text, "extract-typescript: comment text is not a string"),
    kind: requireCommentKind(raw.kind, "extract-typescript: comment kind is not a CommentFacts kind"),
    added: requireBoolean(raw.added, "extract-typescript: comment added is not a boolean"),
  };
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

function classifyCommentKind(text: string, isBlock: boolean, isDoc: boolean): CommentFacts["kind"] {
  if (TOOLING_RE.test(text)) return "tooling";
  if (!isBlock) return "line";
  return isDoc ? "doc" : "block";
}

function commentNodeFacts(node: TSNode, afterLines: string[], beforeLines: Set<string>): CommentFacts[] {
  const isBlock = node.text.startsWith("/*");
  const isDoc = isBlock && node.text.startsWith("/**");
  const startRow = node.startPosition.row + 1;
  const endRow = node.endPosition.row + 1;
  const facts: CommentFacts[] = [];
  for (let line = startRow; line <= endRow; line++) {
    const text = afterLines[line - 1] ?? "";
    facts.push({ line, text, kind: classifyCommentKind(text, isBlock, isDoc), added: !beforeLines.has(text) });
  }
  return facts;
}

function commentFacts(after: string, before: string | undefined, root: TSNode, language: unknown): CommentFacts[] {
  const afterLines = after.split("\n");
  const beforeLines = new Set((before ?? "").split("\n"));
  const q = newQuery(language);
  const facts: CommentFacts[] = [];
  for (const cap of q.captures(root)) {
    if (cap.name !== "comment") continue;
    if (cap.node.type !== "comment") continue;
    facts.push(...commentNodeFacts(cap.node, afterLines, beforeLines));
  }
  return facts;
}

function testCallbackNodes(root: TSNode, q: QueryLike): Set<number> {
  const testNodes = new Set<number>();
  for (const cap of q.captures(root)) {
    if (cap.name !== "testFunction") continue;
    if (!FUNCTION_NODE_TYPES.has(cap.node.type)) continue;
    const parent = cap.node.parent;
    if (parent === null || parent.type !== "arguments") continue;
    if (!isLastNamedChild(parent, cap.node)) continue;
    testNodes.add(cap.node.startIndex);
  }
  return testNodes;
}

function uniqueFunctionNodes(root: TSNode, q: QueryLike): TSNode[] {
  const seen = new Set<number>();
  const functions: TSNode[] = [];
  for (const cap of q.captures(root)) {
    if (cap.name !== "function") continue;
    if (!FUNCTION_NODE_TYPES.has(cap.node.type)) continue;
    const idx = cap.node.startIndex;
    if (seen.has(idx)) continue;
    seen.add(idx);
    functions.push(cap.node);
  }
  return functions;
}

function functionFacts(
  root: TSNode,
  language: unknown,
  path: string,
  after: string,
  before: string | undefined,
): FunctionFacts[] {
  const beforeFuncs = beforeFunctionRegions(language, before);
  const testPath = isTestPath(path);

  const q = newQuery(language);
  const testNodes = testCallbackNodes(root, q);
  const functions = uniqueFunctionNodes(root, q);

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
    const endLine = node.endPosition.row + 1;
    const cc = cyclomaticComplexityWithin(node);

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
      endLine,
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
  const functions = functionFacts(root.rootNode, language, input.path, input.after, input.before);
  const comments = commentFacts(input.after, input.before, root.rootNode, language);
  return { functions, comments };
}

export const typescriptExtractor: Extractor = {
  extract(input): Extracted {
    return validateExtracted(extractRaw(input));
  },
};