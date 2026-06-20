import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOK_DIR =
  process.env.LIUBAI_RAILS_HOOK_DIR ??
  join(homedir(), "code/dotfiles/claude/code/.claude-utils/hooks");

const RAILS = [
  "no_added_comments.py",
  "long_test_nudge.py",
  "cyclomatic_complexity_nudge.py",
  "type_annotation_nudge.py",
] as const;

type ClaudePayload = { tool_name: "Edit" | "Write"; tool_input: Record<string, unknown> };
type TextPart = { type: "text"; text: string };

function claudePayload(toolName: string, input: any): ClaudePayload | null {
  if (toolName === "write") {
    return { tool_name: "Write", tool_input: { file_path: input.path, content: input.content } };
  }
  if (toolName === "edit") {
    return {
      tool_name: "Edit",
      tool_input: { file_path: input.path, old_string: input.oldText, new_string: input.newText },
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

export function register(pi: ExtensionAPI): void {
  const pendingNudges = new Map<string, string[]>();

  pi.on("tool_call", (event: any) => {
    if (railsDisabled()) return undefined;
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
    const nudges = pendingNudges.get(event.toolCallId);
    if (!nudges) return undefined;
    pendingNudges.delete(event.toolCallId);

    const advisory: TextPart = { type: "text", text: "\n\n" + nudges.join("\n\n") };
    return { content: [...event.content, advisory] };
  });
}

export default register;
