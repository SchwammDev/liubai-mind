import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { classify, mergeRules, type CommandRules } from "./command-gate.ts";
import { bashKey, writeKey, editKey, blockReason, bashMatchesDedup } from "./dedup.ts";
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

// pi's `edit` tool carries an `edits[]` array; older builds emitted a single
// flat oldText/newText. Both map onto the hooks' MultiEdit payload.
function editList(input: any): Array<{ oldText: string; newText: string }> {
  return Array.isArray(input.edits)
    ? input.edits
    : [{ oldText: input.oldText, newText: input.newText }];
}

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
async function gateCommand(
  command: string,
  rules: CommandRules,
  ctx: any,
): Promise<{ block: true; reason: string } | undefined> {
  const decision = classify(command, rules);
  if (decision === "deny") return { block: true, reason: `[command-gate] denied: ${command}` };
  if (decision === "ask") {
    if (!ctx.hasUI) {
      return { block: true, reason: `[command-gate] '${command}' needs confirmation; no UI available` };
    }
    const allowed = await ctx.ui.confirm("Run command?", command);
    if (!allowed) return { block: true, reason: `[command-gate] declined: ${command}` };
  }
  return undefined;
}

export function register(pi: ExtensionAPI): void {
  const pendingNudges = new Map<string, string[]>();
  const dedupSeen = new Set<string>();
  const rules = mergeRules(loadRules(GLOBAL_RULES), loadRules(PROJECT_RULES));

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (railsDisabled()) return undefined;

    if (event.toolName === "bash") {
      const command = event.input?.command ?? "";
      const key = bashKey(command);
      if (bashMatchesDedup(command, rules.dedup) && dedupSeen.has(key)) {
        return { block: true, reason: blockReason("bash") };
      }
      return gateCommand(command, rules, ctx);
    }

    if (event.toolName === "write") {
      const key = writeKey(event.input.path, event.input.content);
      if (dedupSeen.has(key)) return { block: true, reason: blockReason("write") };
    } else if (event.toolName === "edit") {
      const key = editKey(event.input.path, editList(event.input));
      if (dedupSeen.has(key)) return { block: true, reason: blockReason("edit") };
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

    if (!event.isError) {
      if (event.toolName === "bash" && bashMatchesDedup(event.input?.command, rules.dedup)) {
        dedupSeen.add(bashKey(event.input.command));
      } else if (event.toolName === "write") {
        dedupSeen.add(writeKey(event.input.path, event.input.content));
      } else if (event.toolName === "edit") {
        dedupSeen.add(editKey(event.input.path, editList(event.input)));
      }
    }

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
