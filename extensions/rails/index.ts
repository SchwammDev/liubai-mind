import {
  createBashToolDefinition,
  createEditToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
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
import { defaultEnv } from "../../engine/env.ts";
import { detectLang } from "../../engine/lang.ts";
import { formatBlockReason } from "../../engine/messages.ts";
import { buildRules, DEFAULT_POLICY } from "../../engine/policy.ts";
import { reconstruct, type FileChange } from "../../engine/reconstruct.ts";

const GLOBAL_RULES = join(homedir(), ".pi/agent/command-rules.json");
const PROJECT_RULES =
  process.env.LIUBAI_RAILS_RULES ?? join(import.meta.dirname, "../../command-rules.json");

type TextPart = { type: "text"; text: string };

function eventToChange(event: ToolCallEvent): FileChange | null {
  if (event.toolName === "write") {
    const write = writeCall(event.input);
    return write ? { kind: "write", path: write.path, content: write.content } : null;
  }
  const edit = event.toolName === "edit" ? editCall(event.input) : null;
  if (!edit) return null;
  return { kind: "edit", path: edit.path, edits: editList(edit) };
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

function resolveToolDefinitions(
  deps: RailsDeps,
  cwd: string,
): { bashTool: BashTool; editTool: EditTool } {
  return {
    bashTool: deps.bashTool ?? createBashToolDefinition(cwd),
    editTool: deps.editTool ?? createEditToolDefinition(cwd),
  };
}

function resolveRuntimeSeams(
  deps: RailsDeps,
  cwd: string,
): { exec: Exec; readTargetFile: (path: string) => Promise<string>; logDedup: DedupLog } {
  return {
    exec: deps.exec ?? createExec(cwd),
    readTargetFile: deps.readTargetFile ?? createTargetReader(cwd),
    logDedup: deps.logDedup ?? createFileLog(),
  };
}

export function register(pi: ExtensionAPI, deps: RailsDeps = {}): void {
  const pendingNudges = new Map<string, string[]>();
  const rules = mergeRules(loadRules(GLOBAL_RULES), loadRules(PROJECT_RULES));
  const webSearch = loadWebSearchConfig(LIUBAI_CONFIG);
  const dedup = createSession();
  const cwd = process.cwd();
  const { bashTool, editTool } = resolveToolDefinitions(deps, cwd);
  const { exec, readTargetFile, logDedup } = resolveRuntimeSeams(deps, cwd);

  pi.registerTool(
    withBashDedup(bashTool, {
      patterns: rules.dedup,
      session: dedup,
      exec,
      log: logDedup,
      enforced: dedupEnforced,
      disabled: railsDisabled,
    }),
  );
  pi.registerTool(
    withEditDedup(editTool, {
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

    const change = eventToChange(event);
    if (!change) return undefined;
    const states = await reconstruct(change, readTargetFile);

    const lang = detectLang(states.path);
    if (!lang) return undefined;

    const env = defaultEnv();
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
