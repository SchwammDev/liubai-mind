import type {
  AgentToolResult,
  BashToolDetails,
  EditToolInput,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Exec = (argv: string[]) => Promise<{ stdout: string; exitCode: number }>;

export type EffectCheck =
  | { effect: "present"; notice: string }
  | { effect: "absent" }
  | { effect: "unqueryable" }
  | { effect: "unparseable" };

export type BashResult = AgentToolResult<BashToolDetails | undefined>;

export type ReplayEntry = Pick<BashResult, "content" | "details">;

export type DedupSession = {
  noopNotices: Map<string, number>;
  approved: Set<string>;
  replayCache: Map<string, ReplayEntry>;
};

export type DedupLogKind =
  | "parse-miss"
  | "would-dedup"
  | "noop"
  | "replay"
  | "escalate-ask"
  | "escalate-block"
  | "duplicate-id"
  | "rail-error";

export type DedupLog = (entry: {
  kind: DedupLogKind;
  tool: string;
  command?: string;
  key?: string;
  action: string;
}) => void;

export const REPLAY_NOTICE =
  "[dedup] identical call already ran this session; original result follows";

const DUPLICATE_RUN_MIN_LINES = 3;

export function createSession(): DedupSession {
  return {
    noopNotices: new Map(),
    approved: new Set(),
    replayCache: new Map(),
  };
}

export function bashKey(command: string): string {
  return "bash\0" + command.trim();
}

export type Edit = { oldText: string; newText: string };

// pi's edit tool takes a list of edits; the flat single-edit shape is the legacy
// form some models still emit. `path` rides along so a tool call named "edit"
// that carries neither shape can be recognised and left alone.
export type EditInput = Pick<EditToolInput, "edits"> | Edit;
export type EditCall = { path: string } & EditInput;

export function editKey(path: string, edits: Edit[]): string {
  return "edit\0" + path + "\0" + sha256(JSON.stringify(edits));
}

export function editList(input: EditInput): Edit[] {
  return "edits" in input ? input.edits : [{ oldText: input.oldText, newText: input.newText }];
}

export function editCall(input: unknown): EditCall | null {
  if (!isRecord(input) || typeof input.path !== "string") return null;
  const path = input.path;
  const edits = input.edits;
  if (Array.isArray(edits)) return edits.every(isEdit) ? { path, edits } : null;
  return isEdit(input) ? { path, oldText: input.oldText, newText: input.newText } : null;
}

function isEdit(value: unknown): value is Edit {
  return isRecord(value) && typeof value.oldText === "string" && typeof value.newText === "string";
}

export type WriteCall = { path: string; content: string };

export function writeCall(input: unknown): WriteCall | null {
  if (!isRecord(input)) return null;
  const { path, content } = input;
  return typeof path === "string" && typeof content === "string" ? { path, content } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function bashMatchesDedup(command: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern).test(command));
}

export function recordNoop(session: DedupSession, key: string): void {
  session.noopNotices.set(key, (session.noopNotices.get(key) ?? 0) + 1);
}

export function repeatedDuplicate(session: DedupSession, key: string): boolean {
  return (session.noopNotices.get(key) ?? 0) >= 1 && !session.approved.has(key);
}

export function approveRerun(session: DedupSession, key: string): void {
  session.approved.add(key);
  session.noopNotices.delete(key);
}

export function consumeApproval(session: DedupSession, key: string): boolean {
  if (!session.approved.has(key)) return false;
  session.approved.delete(key);
  session.noopNotices.delete(key);
  return true;
}

type EffectFamily = "gh-comment" | "gh-state" | "git-tag";

export function effectFamily(command: string): EffectFamily | null {
  if (/\bgh\s+(issue|pr)\s+comment\b/.test(command)) return "gh-comment";
  if (/\bgh\s+(issue|pr)\s+(close|reopen)\b/.test(command)) return "gh-state";
  if (/\bgit\s+tag\b/.test(command)) return "git-tag";
  return null;
}

export async function checkBashEffect(command: string, exec: Exec): Promise<EffectCheck> {
  const family = effectFamily(command);
  if (!family) return { effect: "unqueryable" };
  const words = shellWords(command);
  if (!words) return { effect: "unparseable" };
  if (family === "gh-comment") return ghCommentEffect(words, exec);
  if (family === "gh-state") return ghStateEffect(words, exec);
  return gitTagEffect(words, exec);
}

// Conservative shell tokenizer: any construct whose expansion we cannot predict
// (pipes, substitution, globs, heredocs) bails to null, which callers treat as
// a parse miss that executes normally rather than guessing at semantics.
function isQuote(ch: string): boolean {
  return ch === "'" || ch === '"';
}

function readQuotedSegment(command: string, open: number): { segment: string; end: number } | null {
  const quote = command.charAt(open);
  const end = command.indexOf(quote, open + 1);
  if (end < 0) return null;
  const segment = command.slice(open + 1, end);
  if (quote === '"' && /[$`\\]/.test(segment)) return null;
  return { segment, end };
}

function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (isQuote(ch)) {
      const quoted = readQuotedSegment(command, i);
      if (!quoted) return null;
      current += quoted.segment;
      i = quoted.end;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else if (/[|&;<>`$()\\#*?~{}[\]!]/.test(ch)) {
      return null;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

type GhArgs = { target?: string; repo?: string; values: Map<string, string> };

type GhSlot = { kind: "repo" } | { kind: "value"; name: string };

function ghSlotOf(flag: string, valueFlags: Record<string, string>): GhSlot | null {
  if (flag === "--repo" || flag === "-R") return { kind: "repo" };
  const name = valueFlags[flag];
  return name === undefined ? null : { kind: "value", name };
}

function ghFlagValue(
  inline: string | undefined,
  next: string | undefined,
): { value: string; consumed: number } | null {
  const value = inline ?? next;
  if (value === undefined) return null;
  return { value, consumed: inline === undefined ? 1 : 0 };
}

type GhWordResult =
  | { kind: "reject" }
  | { kind: "target"; value: string }
  | { kind: "repo"; value: string; consumed: number }
  | { kind: "value"; name: string; value: string; consumed: number };

function classifyGhWord(
  word: string,
  next: string | undefined,
  valueFlags: Record<string, string>,
  rejectFlags: string[],
): GhWordResult {
  const [flag, inline] = word.startsWith("--") ? splitInline(word) : [word, undefined];
  if (rejectFlags.includes(flag)) return { kind: "reject" };
  const slot = ghSlotOf(flag, valueFlags);
  if (slot) {
    const taken = ghFlagValue(inline, next);
    if (!taken) return { kind: "reject" };
    return slot.kind === "repo"
      ? { kind: "repo", value: taken.value, consumed: taken.consumed }
      : { kind: "value", name: slot.name, value: taken.value, consumed: taken.consumed };
  }
  if (flag.startsWith("-")) return { kind: "reject" };
  return { kind: "target", value: word };
}

function parseGhArgs(
  rest: string[],
  valueFlags: Record<string, string>,
  rejectFlags: string[],
): GhArgs | null {
  const args: GhArgs = { values: new Map() };
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (word === undefined) return null;
    const res = classifyGhWord(word, rest[i + 1], valueFlags, rejectFlags);
    if (res.kind === "reject") return null;
    if (res.kind === "target") {
      if (args.target !== undefined) return null;
      args.target = res.value;
    } else if (res.kind === "repo") {
      args.repo = res.value;
      i += res.consumed;
    } else {
      args.values.set(res.name, res.value);
      i += res.consumed;
    }
  }
  return args;
}

function splitInline(word: string): [string, string | undefined] {
  const eq = word.indexOf("=");
  return eq < 0 ? [word, undefined] : [word.slice(0, eq), word.slice(eq + 1)];
}

function ghViewArgv(kind: string, args: GhArgs, field: string): string[] {
  return [
    "gh",
    kind,
    "view",
    ...(args.target ? [args.target] : []),
    ...(args.repo ? ["--repo", args.repo] : []),
    "--json",
    field,
  ];
}

type GhHeader = { kind: string; sub: string; rest: string[] };

function ghHeader(words: string[]): GhHeader | null {
  const [gh, kind, sub, ...rest] = words;
  if (gh !== "gh" || kind === undefined || sub === undefined) return null;
  return { kind, sub, rest };
}

async function findPostedComment(
  kind: string,
  args: GhArgs,
  body: string,
  exec: Exec,
): Promise<GhComment | null> {
  const res = await exec(ghViewArgv(kind, args, "comments"));
  if (res.exitCode !== 0) return null;
  return (
    parseComments(res.stdout).find((comment) => normalizeBody(comment.body) === normalizeBody(body)) ??
    null
  );
}

async function ghCommentEffect(words: string[], exec: Exec): Promise<EffectCheck> {
  const header = ghHeader(words);
  if (!header || header.sub !== "comment") return { effect: "unparseable" };
  const { kind, rest } = header;
  const args = parseGhArgs(
    rest,
    { "--body": "body", "-b": "body" },
    ["--body-file", "-F", "--editor", "-e", "--web", "-w", "--edit-last"],
  );
  const body = args?.values.get("body");
  if (!args || body === undefined) return { effect: "unparseable" };
  if (kind === "issue" && !args.target) return { effect: "unparseable" };

  const existing = await findPostedComment(kind, args, body, exec);
  return existing
    ? { effect: "present", notice: `comment already posted: ${existing.url}` }
    : { effect: "absent" };
}

async function stateMatches(kind: string, args: GhArgs, sub: string, exec: Exec): Promise<boolean> {
  const res = await exec(ghViewArgv(kind, args, "state"));
  if (res.exitCode !== 0) return false;
  const parsed = parseJson(res.stdout);
  const state = isRecord(parsed) ? parsed.state : undefined;
  return state === (sub === "close" ? "CLOSED" : "OPEN");
}

function statePresentNotice(kind: string, target: string | undefined, sub: string): EffectCheck {
  const verb = sub === "close" ? "closed" : "open";
  return { effect: "present", notice: `${kind} ${target ?? ""} already ${verb}`.replace("  ", " ") };
}

async function ghStateEffect(words: string[], exec: Exec): Promise<EffectCheck> {
  const header = ghHeader(words);
  if (!header || (header.sub !== "close" && header.sub !== "reopen")) return { effect: "unparseable" };
  const { kind, sub, rest } = header;
  const args = parseGhArgs(rest, { "--comment": "comment", "-c": "comment", "--reason": "reason", "-r": "reason" }, []);
  if (!args) return { effect: "unparseable" };
  if (kind === "issue" && !args.target) return { effect: "unparseable" };

  if (!(await stateMatches(kind, args, sub, exec))) return { effect: "absent" };
  return statePresentNotice(kind, args.target, sub);
}

const GIT_TAG_BOOL_FLAGS = ["-a", "--annotate", "-s", "--sign", "-f", "--force"];
const GIT_TAG_VALUE_FLAGS = ["-m", "--message", "-F", "--file", "-u", "--local-user"];

function gitTagName(rest: string[]): string | null {
  let name: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (word === undefined) return null;
    if (GIT_TAG_BOOL_FLAGS.includes(word)) continue;
    if (GIT_TAG_VALUE_FLAGS.includes(word)) {
      i++;
    } else if (word.startsWith("-")) {
      return null;
    } else if (name === undefined) {
      name = word;
    } else {
      return null;
    }
  }
  return name || null;
}

async function tagAtHead(name: string, exec: Exec): Promise<EffectCheck> {
  const tag = await exec(["git", "rev-parse", `refs/tags/${name}^{commit}`]);
  if (tag.exitCode !== 0) return { effect: "absent" };
  const head = await exec(["git", "rev-parse", "HEAD"]);
  if (head.exitCode !== 0 || tag.stdout.trim() !== head.stdout.trim()) return { effect: "absent" };
  return { effect: "present", notice: `tag ${name} already exists at HEAD` };
}

async function gitTagEffect(words: string[], exec: Exec): Promise<EffectCheck> {
  const [git, sub, ...rest] = words;
  if (git !== "git" || sub !== "tag") return { effect: "unparseable" };
  const name = gitTagName(rest);
  if (!name) return { effect: "unparseable" };
  return tagAtHead(name, exec);
}

type GhComment = { body: string; url: string };

function parseComments(stdout: string): GhComment[] {
  const parsed = parseJson(stdout);
  const comments = isRecord(parsed) ? parsed.comments : undefined;
  return Array.isArray(comments) ? comments.filter(isGhComment) : [];
}

function isGhComment(value: unknown): value is GhComment {
  return isRecord(value) && typeof value.body === "string" && typeof value.url === "string";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeBody(body: string): string {
  return body.toLowerCase().replace(/\s+/g, " ").trim();
}

export function duplicateEditInsertion(
  fileContent: string,
  edits: Array<{ oldText: string; newText: string }>,
): { line: number } | null {
  const fileLines = fileContent.split("\n").map((line) => line.trim());
  for (const edit of edits) {
    const line = duplicatedRunLine(fileLines, edit);
    if (line !== null) return { line };
  }
  return null;
}

function duplicatedRunLine(
  fileLines: string[],
  edit: { oldText: string; newText: string },
): number | null {
  for (const run of addedRuns(edit.oldText ?? "", edit.newText ?? "")) {
    if (run.filter((line) => line).length < DUPLICATE_RUN_MIN_LINES) continue;
    const line = findConsecutive(fileLines, run);
    if (line !== null) return line;
  }
  return null;
}

function addedRuns(oldText: string, newText: string): string[][] {
  const oldLines = new Set(oldText.split("\n").map((line) => line.trim()));
  const runs: string[][] = [];
  let current: string[] = [];
  for (const line of newText.split("\n")) {
    const trimmed = line.trim();
    if (oldLines.has(trimmed)) {
      if (current.length) runs.push(current);
      current = [];
    } else {
      current.push(trimmed);
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

function findConsecutive(fileLines: string[], run: string[]): number | null {
  outer: for (let i = 0; i + run.length <= fileLines.length; i++) {
    for (let j = 0; j < run.length; j++) {
      if (fileLines[i + j] !== run[j]) continue outer;
    }
    return i + 1;
  }
  return null;
}

export function createFileLog(
  path: string = join(homedir(), ".pi/agent/liubai-dedup-log.jsonl"),
): DedupLog {
  return (entry) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    } catch {
      // Logging must never break tool execution.
    }
  };
}

export function createExec(cwd: string): Exec {
  return ([file, ...args]) => {
    if (file === undefined) return Promise.resolve({ stdout: "", exitCode: 1 });
    return new Promise((resolvePromise) => {
      execFile(file, args, { cwd, encoding: "utf8" }, (error, stdout) => {
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolvePromise({ stdout: stdout ?? "", exitCode });
      });
    });
  };
}

export function createTargetReader(cwd: string): (path: string) => Promise<string> {
  return (path) => {
    const absolute = path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(cwd, path);
    return readFile(absolute, "utf8");
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
