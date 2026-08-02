// Claude Code PreToolUse adapter. stdin → analyze → block (exit 2 + stderr) or
// nudge (exit 0 + stdout JSON) or pass (exit 0 silent). Fails open on every
// error path: a guardrail must never brick edits on a malformed payload.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { analyze } from "./analyze.ts";
import { defaultEnv } from "./env.ts";
import { reconstruct, type FileChange } from "./reconstruct.ts";
import { detectLang } from "./lang.ts";
import { buildRules, DEFAULT_POLICY } from "./policy.ts";
import { formatBlockReason } from "./messages.ts";

type CcPayload = {
  hook_event_name?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  cwd?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// Maps a CC PreToolUse payload to a FileChange, or null for anything the rails
// don't cover (non-edit tools, missing fields, non-string values).
export function mapChange(payload: CcPayload): FileChange | null {
  const tool = asString(payload.tool_name);
  const input = isObject(payload.tool_input) ? payload.tool_input : undefined;
  if (tool === undefined || input === undefined) return null;

  if (tool === "Write") {
    const path = asString(input.file_path);
    const content = asString(input.content);
    if (path === undefined || content === undefined) return null;
    return { kind: "write", path, content };
  }

  if (tool === "Edit") {
    const path = asString(input.file_path);
    const oldText = asString(input.old_string);
    const newText = asString(input.new_string);
    if (path === undefined || oldText === undefined || newText === undefined) return null;
    return { kind: "edit", path, edits: [{ oldText, newText }] };
  }

  if (tool === "MultiEdit") {
    const path = asString(input.file_path);
    const rawEdits = input.edits;
    if (path === undefined || !Array.isArray(rawEdits)) return null;
    const edits: { oldText: string; newText: string }[] = [];
    for (const e of rawEdits) {
      if (!isObject(e)) return null;
      const oldText = asString(e.old_string);
      const newText = asString(e.new_string);
      if (oldText === undefined || newText === undefined) return null;
      edits.push({ oldText, newText });
    }
    return { kind: "edit", path, edits };
  }

  return null;
}

async function main(): Promise<void> {
  const stdin = await readStdin();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    return; // fail open
  }
  if (!isObject(parsed)) return; // fail open

  const payload = parsed as CcPayload;
  const change = mapChange(payload);
  if (change === null) return;

  const cwd = asString(payload.cwd) ?? process.cwd();
  const read = (p: string) => readFile(resolve(cwd, p), "utf8");

  const { path, before, after } = await reconstruct(change, read);
  const lang = detectLang(path);
  if (lang === undefined) return;

  // resp.errors is intentionally ignored: a CC hook has no log channel, and a
  // guardrail must not brick edits on extractor failure. Known limitation.
  const resp = await analyze({ path, before, after, lang }, defaultEnv(), buildRules(DEFAULT_POLICY, lang));

  const blocks = resp.nudges.filter((n) => n.severity === "block");
  if (blocks.length > 0) {
    process.stderr.write(`${formatBlockReason(path, blocks)}\n`);
    process.exit(2);
  }

  const nudges = resp.nudges.filter((n) => n.severity === "nudge");
  if (nudges.length > 0) {
    const additionalContext = nudges.map((n) => `[${n.rule}] ${n.msg}`).join("\n\n");
    const out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext,
      },
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }

  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

if (import.meta.main) {
  // fail open — no log channel in a CC hook
  await main().catch(() => process.exit(0));
}
