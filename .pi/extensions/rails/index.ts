import {
  createBashToolDefinition,
  createEditToolDefinition,
  type ExtensionAPI,
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
  editKey,
  editList,
  repeatedDuplicate,
  type DedupLog,
  type Exec,
} from "./dedup.ts";
import { withBashDedup, withEditDedup, type ToolLike } from "./overrides.ts";
import { withoutDuplicateToolCalls } from "./duplicate-delivery.ts";
import { cleanProse } from "./prose-gate.ts";
import { injectWebSearch } from "./web-search.ts";

// Command-gate rules merge a personal global file under a project-local one;
// either may be absent (no gating). LIUBAI_RAILS_RULES overrides the project path.
const GLOBAL_RULES = join(homedir(), ".pi/agent/command-rules.json");
const PROJECT_RULES =
  process.env.LIUBAI_RAILS_RULES ?? join(import.meta.dirname, "../../command-rules.json");

const HOOK_DIR = join(import.meta.dirname, "hooks");

const RAILS = [
  "no_added_comments.py",
  "long_test_nudge.py",
  "cyclomatic_complexity_nudge.py",
  "type_annotation_nudge.py",
] as const;

type ClaudePayload = { tool_name: "Edit" | "Write" | "MultiEdit"; tool_input: Record<string, unknown> };
type TextPart = { type: "text"; text: string };

function claudePayload(toolName: string, input: any): ClaudePayload | null {
  if (toolName === "write") {
    return { tool_name: "Write", tool_input: { file_path: input.path, content: input.content } };
  }
  if (toolName === "edit") {
    return {
      tool_name: "MultiEdit",
      tool_input: {
        file_path: input.path,
        edits: editList(input).map((e) => ({ old_string: e.oldText, new_string: e.newText })),
      },
    };
  }
  return null;
}

// A rail exits 2 to hard-block (message on stderr), or exits 0 with an
// `additionalContext` advisory to nudge without blocking.
function runRail(name: string, payload: ClaudePayload): { block: string } | { nudge: string } | null {
  const res = spawnSync("python3", [join(HOOK_DIR, name)], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  if (res.status === 2) return { block: res.stderr.trim() };
  if (res.status !== 0 || !res.stdout.trim()) return null;
  try {
    const advisory = JSON.parse(res.stdout)?.hookSpecificOutput?.additionalContext;
    return typeof advisory === "string" && advisory ? { nudge: advisory } : null;
  } catch {
    return null;
  }
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
  ctx: any,
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
  bashTool?: ToolLike;
  editTool?: ToolLike;
  exec?: Exec;
  readTargetFile?: (path: string) => Promise<string>;
  logDedup?: DedupLog;
};

export function register(pi: ExtensionAPI, deps: RailsDeps = {}): void {
  const pendingNudges = new Map<string, string[]>();
  const rules = mergeRules(loadRules(GLOBAL_RULES), loadRules(PROJECT_RULES));
  const dedup = createSession();
  const logDedup = deps.logDedup ?? createFileLog();
  const cwd = process.cwd();

  pi.registerTool(
    withBashDedup((deps.bashTool ?? createBashToolDefinition(cwd)) as ToolLike, {
      patterns: rules.dedup,
      session: dedup,
      exec: deps.exec ?? createExec(cwd),
      log: logDedup,
      enforced: dedupEnforced,
      disabled: railsDisabled,
    }) as any,
  );
  pi.registerTool(
    withEditDedup((deps.editTool ?? createEditToolDefinition(cwd)) as ToolLike, {
      session: dedup,
      readTargetFile: deps.readTargetFile ?? createTargetReader(cwd),
      log: logDedup,
      enforced: dedupEnforced,
      disabled: railsDisabled,
    }) as any,
  );

  // Duplicate delivery (issue #15): the message_end drop is the structural
  // fix; the tool_call detector is a log-only tripwire so a future duplicate
  // that slips past finalization shows up in the log instead of in silence.
  // Both are correctness, not steering — active under LIUBAI_RAILS_OFF.
  pi.on("message_end", (event: any) => {
    if (event.message.role !== "assistant") return undefined;
    const deduped = withoutDuplicateToolCalls(event.message, logDedup);
    return deduped ? { message: deduped } : undefined;
  });

  const seenCallIds = new Set<string>();
  pi.on("tool_call", (event: any) => {
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
    ctx: any,
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

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (railsDisabled()) return undefined;

    if (event.toolName === "bash") {
      const command = event.input?.command ?? "";
      let skipAsk = false;
      if (dedupEnforced() && bashMatchesDedup(command, rules.dedup)) {
        const outcome = await resolveRepeat(bashKey(command), command, "bash", ctx);
        if ("block" in outcome) return outcome;
        skipAsk = outcome.skipAsk;
      }
      return gateCommand(command, rules, ctx, skipAsk);
    }

    if (event.toolName === "edit" && dedupEnforced()) {
      const key = editKey(event.input.path, editList(event.input));
      const outcome = await resolveRepeat(key, `edit ${event.input.path}`, "edit", ctx);
      if ("block" in outcome) return outcome;
    }

    const payload = claudePayload(event.toolName, event.input);
    if (!payload) return undefined;

    const nudges: string[] = [];
    for (const name of RAILS) {
      const outcome = runRail(name, payload);
      if (outcome && "block" in outcome) {
        return { block: true, reason: `[${name}] ${outcome.block}` };
      }
      if (outcome && "nudge" in outcome) nudges.push(`[${name}] ${outcome.nudge}`);
    }
    if (nudges.length) pendingNudges.set(event.toolCallId, nudges);
    return undefined;
  });

  pi.on("tool_result", (event: any) => {
    if (railsDisabled()) return undefined;

    const nudges = pendingNudges.get(event.toolCallId);
    if (!nudges) return undefined;
    pendingNudges.delete(event.toolCallId);

    const advisory: TextPart = { type: "text", text: "\n\n" + nudges.join("\n\n") };
    return { content: [...event.content, advisory] };
  });

  // Capability, not steering: stays on under LIUBAI_RAILS_OFF so baseline
  // comparisons vary only the steering, never what the agent can reach.
  pi.on("before_provider_request", (event: any, ctx: any) =>
    injectWebSearch(event.payload, ctx.model),
  );

  pi.on("message_end", (event: any) => {
    if (railsDisabled()) return undefined;
    if (event.message.role !== "assistant") return undefined;
    return { message: cleanProse(event.message) };
  });
}

export default register;
