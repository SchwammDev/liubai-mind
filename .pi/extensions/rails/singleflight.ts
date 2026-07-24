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
