import {
  createBashToolDefinition,
  createEditToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { classify, mergeRules, type CommandRules } from "./command-gate.ts";
import {
  approveRerun,
  bashKey,
  bashMatchesDedup,
  createExec,
  createFileLog,
  createSession,
  createTargetReader,
  editCall,
  editKey,
  editList,
  repeatedDuplicate,
  writeCall,
  type DedupLog,
  type Exec,
} from "./dedup.ts";
import { withBashDedup, withEditDedup, type BashTool, type EditTool } from "./overrides.ts";
import { withoutDuplicateToolCalls } from "./duplicate-delivery.ts";
import { cleanProse } from "./prose-gate.ts";
import { injectWebSearch, loadWebSearchConfig, LIUBAI_CONFIG } from "./web-search.ts";
import { analyze } from "../../engine/analyze.ts";
import { pythonExtractor } from "../../engine/extract-python.ts";
import { detectLang } from "../../engine/lang.ts";
import { buildRules, DEFAULT_POLICY } from "../../engine/policy.ts";
import type { Env, Lang, Nudge } from "../../engine/contract.ts";

// Command-gate rules merge a personal global file under a project-local one;
// either may be absent (no gating). LIUBAI_RAILS_RULES overrides the project path.
const GLOBAL_RULES = join(homedir(), ".pi/agent/command-rules.json");
const PROJECT_RULES =
  process.env.LIUBAI_RAILS_RULES ?? join(import.meta.dirname, "../../command-rules.json");

type TextPart = { type: "text"; text: string };

const DISCOURAGE_COMMENTS_GUIDANCE =
  "Comments and docstrings are both noise here — write expressive code. " +
  "Remove docstrings too, not just '#' lines. " +
  "If you truly think a WHY-comment is justified, propose it to the user before writing it.";

const TOOLING_DIRECTIVES_FOOTER =
  "Tooling directives are allowed and not blocked: '# ty: ignore[...]', '# type: ignore', '# noqa', '# pragma:', '# pyright:'.";

// `before` is the file on disk and `after` is the disk content with the edit
// applied — not the edit's own old/new strings, which carry no surrounding
// context. Function rules need the full file; the comment rule's before/after
// line-set diff then sees added lines correctly.
function applyEdits(text: string, edits: { oldText: string; newText: string }[]): string {
  let out = text;
  for (const edit of edits) out = out.replace(edit.oldText, edit.newText);
  return out;
}

async function safeRead(read: (path: string) => Promise<string>, path: string): Promise<string> {
  try {
    return await read(path);
  } catch {
    return "";
  }
}

async function reconstructStates(
  event: ToolCallEvent,
  readTargetFile: (path: string) => Promise<string>,
): Promise<{ path: string; before: string; after: string } | null> {
  if (event.toolName === "write") {
    const write = writeCall(event.input);
    if (!write) return null;
    const before = await safeRead(readTargetFile, write.path);
    return { path: write.path, before, after: write.content };
  }
  const edit = event.toolName === "edit" ? editCall(event.input) : null;
  if (!edit) return null;
  const before = await safeRead(readTargetFile, edit.path);
  return { path: edit.path, before, after: applyEdits(before, editList(edit)) };
}

// The discourage-comments nudge embeds the comment snippet in its msg as
// `L{n}: "{snippet}" — …`; the block reason lists one line per added comment,
// so the snippet is peeled back out rather than re-extracting.
function snippetFromNudgeMsg(msg: string): string {
  const marker = ': "';
  const start = msg.indexOf(marker);
  if (start === -1) return "";
  const rest = msg.slice(start + marker.length);
  const end = rest.indexOf('" —');
  return end === -1 ? rest : rest.slice(0, end);
}

function formatBlockReason(path: string, blockNudges: Nudge[]): string {
  const lines = blockNudges
    .map((n) => `  L${n.line ?? "?"}: ${snippetFromNudgeMsg(n.msg) || "(comment)"}`)
    .join("\n");
  return `Blocked: new Python comments/docstrings detected in ${path}:\n${lines}\n\n${DISCOURAGE_COMMENTS_GUIDANCE}\n${TOOLING_DIRECTIVES_FOOTER}`;
}

// Mirrors the old long_test_nudge.py helper inventory: `assert_*` / `_*`
// helpers in tests/, deduped, capped. Empty when there is no tests/ or grep is
// unavailable. The engine's test-body rule only calls this when a long test is
// flagged, so it never runs on a clean call.
function helpersFor(lang: Lang): string[] {
  if (lang !== "python") return [];
  const res = spawnSync("grep", ["-rh", "-E", "^def (assert_|_)", "tests"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (res.error || res.status !== 0) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of res.stdout.split("\n")) {
    const match = /^def (\w+)/.exec(line);
    if (!match || match[1] === undefined) continue;
    const name = match[1];
    if (name === "_" || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names.slice(0, 6);
}

// Rails steer by default; setting LIUBAI_RAILS_OFF yields the un-steered
// baseline without swapping engines, keeping the comparison a clean toggle.
const railsDisabled = (): boolean => Boolean(process.env.LIUBAI_RAILS_OFF);

// Dedup ships log-only: detectors observe and log until LIUBAI_DEDUP_ENFORCE
// flips no-ops, replays, and escalations on.
const dedupEnforced = (): boolean => Boolean(process.env.LIUBAI_DEDUP_ENFORCE);

// A missing or malformed file yields no rules, so the gate stays open rather
// than bricking the agent on a typo.
function loadRules(path: string): Partial<CommandRules> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

// `ask` needs an interactive prompt; with no UI (headless `-p`/rpc) it blocks,
// so an unattended run can't slip a gated command through unconfirmed.
// `skipAsk` bypasses only the confirmation, and only right after the user
// confirmed this exact duplicate; deny stays absolute.
async function gateCommand(
  command: string,
  rules: CommandRules,
  ctx: ExtensionContext,
  skipAsk = false,
): Promise<{ block: true; reason: string } | undefined> {
  const decision = classify(command, rules);
  if (decision === "deny") return { block: true, reason: `[command-gate] denied: ${command}` };
  if (decision === "ask" && !skipAsk) {
    if (!ctx.hasUI) {
      return { block: true, reason: `[command-gate] '${command}' needs confirmation; no UI available` };
    }
    const allowed = await ctx.ui.confirm("Run command?", command);
    if (!allowed) return { block: true, reason: `[command-gate] declined: ${command}` };
  }
  return undefined;
}

// Test seam: production wiring uses the real tools and process adapters,
// tests inject fakes so no command ever leaves the process.
export type RailsDeps = {
  bashTool?: BashTool;
  editTool?: EditTool;
  exec?: Exec;
  readTargetFile?: (path: string) => Promise<string>;
  logDedup?: DedupLog;
};

export function register(pi: ExtensionAPI, deps: RailsDeps = {}): void {
  const pendingNudges = new Map<string, string[]>();
  const rules = mergeRules(loadRules(GLOBAL_RULES), loadRules(PROJECT_RULES));
  const webSearch = loadWebSearchConfig(LIUBAI_CONFIG);
  const dedup = createSession();
  const logDedup = deps.logDedup ?? createFileLog();
  const cwd = process.cwd();
  const readTargetFile = deps.readTargetFile ?? createTargetReader(cwd);

  pi.registerTool(
    withBashDedup(deps.bashTool ?? createBashToolDefinition(cwd), {
      patterns: rules.dedup,
      session: dedup,
      exec: deps.exec ?? createExec(cwd),
      log: logDedup,
      enforced: dedupEnforced,
      disabled: railsDisabled,
    }),
  );
  pi.registerTool(
    withEditDedup(deps.editTool ?? createEditToolDefinition(cwd), {
      session: dedup,
      readTargetFile,
      log: logDedup,
      enforced: dedupEnforced,
      disabled: railsDisabled,
    }),
  );

  // Duplicate delivery (issue #15): the message_end drop is the structural
  // fix; the tool_call detector is a log-only tripwire so a future duplicate
  // that slips past finalization shows up in the log instead of in silence.
  // Both are correctness, not steering — active under LIUBAI_RAILS_OFF.
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return undefined;
    const deduped = withoutDuplicateToolCalls(event.message, logDedup);
    return deduped ? { message: deduped } : undefined;
  });

  const seenCallIds = new Set<string>();
  pi.on("tool_call", (event) => {
    if (!event.toolCallId) return undefined;
    if (seenCallIds.has(event.toolCallId)) {
      logDedup({ kind: "duplicate-id", tool: event.toolName, key: event.toolCallId, action: "observed" });
    } else {
      seenCallIds.add(event.toolCallId);
    }
    return undefined;
  });

  // A key that already no-opped once is being re-issued despite the notice:
  // ask the user, since retry loops are exactly what the no-op should end.
  async function resolveRepeat(
    key: string,
    describe: string,
    tool: string,
    ctx: ExtensionContext,
  ): Promise<{ block: true; reason: string } | { skipAsk: boolean }> {
    if (repeatedDuplicate(dedup, key)) {
      if (!ctx?.hasUI) {
        logDedup({ kind: "escalate-block", tool, key, action: "no-ui" });
        return { block: true, reason: `[dedup] duplicate needs confirmation; no UI available: ${describe}` };
      }
      const confirmed = await ctx.ui.confirm("Run duplicate again?", describe);
      if (!confirmed) {
        logDedup({ kind: "escalate-block", tool, key, action: "declined" });
        return { block: true, reason: `[dedup] duplicate declined: ${describe}` };
      }
      logDedup({ kind: "escalate-ask", tool, key, action: "approved" });
      approveRerun(dedup, key);
      return { skipAsk: true };
    }
    return { skipAsk: false };
  }

  // An extractor that cannot run fails open: the log keeps every occurrence,
  // while the operator hears once per session — a failure on every write would
  // be noise, and the agent can do nothing with the news either way.
  let railFailureNotified = false;
  const reportRailFailure = (rail: string, tool: string, reason: string, ctx?: ExtensionContext) => {
    logDedup({ kind: "rail-error", tool, key: rail, action: reason });
    if (!ctx?.hasUI || railFailureNotified) return;
    railFailureNotified = true;
    ctx.ui.notify(`[${rail}] rail failed: ${reason}`, "error");
  };

  pi.on("tool_call", async (event, ctx) => {
    if (railsDisabled()) return undefined;

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      let skipAsk = false;
      if (dedupEnforced() && bashMatchesDedup(command, rules.dedup)) {
        const outcome = await resolveRepeat(bashKey(command), command, "bash", ctx);
        if ("block" in outcome) return outcome;
        skipAsk = outcome.skipAsk;
      }
      return gateCommand(command, rules, ctx, skipAsk);
    }

    const edit = event.toolName === "edit" ? editCall(event.input) : null;
    if (edit && dedupEnforced()) {
      const key = editKey(edit.path, editList(edit));
      const outcome = await resolveRepeat(key, `edit ${edit.path}`, "edit", ctx);
      if ("block" in outcome) return outcome;
    }

    const states = await reconstructStates(event, readTargetFile);
    if (!states) return undefined;

    const lang = detectLang(states.path);
    if (!lang) return undefined;

    const env: Env = { extractors: { python: pythonExtractor }, helpers: helpersFor };
    const analyzeRules = buildRules(DEFAULT_POLICY, lang);
    const resp = await analyze(
      { path: states.path, before: states.before, after: states.after, lang },
      env,
      analyzeRules,
    );

    for (const err of resp.errors) {
      reportRailFailure("extract:python", event.toolName, err.msg, ctx);
    }

    const blockNudges = resp.nudges.filter((n) => n.severity === "block");
    if (blockNudges.length) {
      return { block: true, reason: `[discourage-comments] ${formatBlockReason(states.path, blockNudges)}` };
    }

    const railNudges = resp.nudges.map((n) => `[${n.rule}] ${n.msg}`);
    if (railNudges.length) pendingNudges.set(event.toolCallId, railNudges);
    return undefined;
  });

  pi.on("tool_result", (event) => {
    if (railsDisabled()) return undefined;

    const nudges = pendingNudges.get(event.toolCallId);
    if (!nudges) return undefined;
    pendingNudges.delete(event.toolCallId);

    const advisory: TextPart = { type: "text", text: "\n\n" + nudges.join("\n\n") };
    return { content: [...event.content, advisory] };
  });

  // A malformed liubai.json leaves web search off, which is safe but silent, so
  // the operator hears the reason once rather than on every LLM call.
  let webSearchConfigNotified = false;
  const reportWebSearchConfig = (ctx: ExtensionContext) => {
    if (!webSearch.error || !ctx.hasUI || webSearchConfigNotified) return;
    webSearchConfigNotified = true;
    ctx.ui.notify(`[web-search] ${webSearch.error}`, "error");
  };

  // Capability, not steering: stays on under LIUBAI_RAILS_OFF so baseline
  // comparisons vary only the steering, never what the agent can reach.
  pi.on("before_provider_request", (event, ctx) => {
    reportWebSearchConfig(ctx);
    return injectWebSearch(event.payload, ctx.model, webSearch.providers);
  });

  pi.on("message_end", (event) => {
    if (railsDisabled()) return undefined;
    if (event.message.role !== "assistant") return undefined;
    return { message: cleanProse(event.message) };
  });
}

export default register;
