import type { DedupLog } from "./dedup.ts";
import type { ToolLike } from "./overrides.ts";

export type InFlightCalls = Map<string, Promise<any>>;

// Coalescing window: duplicates arrive within one assistant message, so a small
// bounded history is enough; evicting old entries keeps large results collectable.
const MAX_TRACKED_CALLS = 200;

const WRAP_MARKER = "__liubaiSingleFlight";

// pi's openai-responses adapter can append the same streamed tool call twice
// (identical toolCallId) and then executes both copies — the source of the
// observed double posts and commits. Same id means same logical call, so the
// duplicate coalesces onto the first execution instead of re-running the side
// effect. Bug shield, not steering: callers keep it on under LIUBAI_RAILS_OFF.
export function withSingleFlight(tool: ToolLike, calls: InFlightCalls, log: DedupLog): ToolLike {
  if ((tool as any)[WRAP_MARKER]) return tool;
  const wrapped: ToolLike = {
    ...tool,
    [WRAP_MARKER]: true,
    execute(toolCallId: string, ...rest: any[]) {
      const existing = calls.get(toolCallId);
      if (existing) {
        log({ kind: "duplicate-id", tool: tool.name, key: toolCallId, action: "coalesced" });
        return existing;
      }
      const run = tool.execute(toolCallId, ...rest);
      calls.set(toolCallId, run);
      evictBeyondWindow(calls);
      return run;
    },
  };
  return wrapped;
}

function evictBeyondWindow(calls: InFlightCalls): void {
  while (calls.size > MAX_TRACKED_CALLS) {
    calls.delete(calls.keys().next().value!);
  }
}

type MessageLike = { role: string; content: any[] };

// Same upstream bug, caught earlier: dropping the duplicate blocks at
// message_end stops both the double execution and the doubled context, since
// pi extracts tool calls and persists from the replaced message. Keep the LAST
// copy — it comes from the terminal output_item.done event, whose arguments
// are authoritative. Returns null when the message is already clean.
export function withoutDuplicateToolCalls<T extends MessageLike>(
  message: T,
  log: DedupLog,
): T | null {
  const seen = new Set<string>();
  const kept: any[] = [];
  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i];
    if (part?.type === "toolCall") {
      if (seen.has(part.id)) {
        log({ kind: "duplicate-id", tool: part.name, key: part.id, action: "dropped-from-message" });
        continue;
      }
      seen.add(part.id);
    }
    kept.unshift(part);
  }
  return kept.length === message.content.length ? null : { ...message, content: kept };
}
