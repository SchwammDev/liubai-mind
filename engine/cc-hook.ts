import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { analyze } from "./analyze.ts";
import { defaultEnv } from "./env.ts";
import { reconstruct, type FileChange } from "./reconstruct.ts";
import type { Nudge } from "./contract.ts";
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

function mapWrite(input: Record<string, unknown>): FileChange | null {
  const path = asString(input.file_path);
  const content = asString(input.content);
  if (path === undefined || content === undefined) return null;
  return { kind: "write", path, content };
}

function mapEdit(input: Record<string, unknown>): FileChange | null {
  const path = asString(input.file_path);
  const oldText = asString(input.old_string);
  const newText = asString(input.new_string);
  if (path === undefined || oldText === undefined || newText === undefined) return null;
  return { kind: "edit", path, edits: [{ oldText, newText }] };
}

function mapMultiEdit(input: Record<string, unknown>): FileChange | null {
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

export function mapChange(payload: CcPayload): FileChange | null {
  const tool = asString(payload.tool_name);
  const input = isObject(payload.tool_input) ? payload.tool_input : undefined;
  if (tool === undefined || input === undefined) return null;

  if (tool === "Write") return mapWrite(input);
  if (tool === "Edit") return mapEdit(input);
  if (tool === "MultiEdit") return mapMultiEdit(input);

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

  emitDecision(path, resp.nudges);
}

function emitDecision(path: string, nudges: Nudge[]): never {
  const blocks = nudges.filter((n) => n.severity === "block");
  if (blocks.length > 0) {
    process.stderr.write(`${formatBlockReason(path, blocks)}\n`);
    process.exit(2);
  }

  const advisories = nudges.filter((n) => n.severity === "nudge");
  if (advisories.length > 0) {
    const additionalContext = advisories.map((n) => `[${n.rule}] ${n.msg}`).join("\n\n");
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
