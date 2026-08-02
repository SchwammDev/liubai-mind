import type { MessageEndEvent } from "@earendil-works/pi-coding-agent";

import type { DedupLog } from "./dedup.ts";

type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

export type MessagePart = AssistantMessage["content"][number];
export type MessageLike = { role: string; content: MessagePart[] };

// pi's openai-responses adapter can append the same streamed tool call twice
// (identical toolCallId) when the gateway emits inconsistent output_index
// values — see issue #15. Dropping the duplicates at message_end cures both
// the double execution and the doubled context, since pi extracts tool calls
// and persists from the replaced message. Keep the LAST copy — it comes from
// the terminal output_item.done event, whose arguments are authoritative.
export function withoutDuplicateToolCalls<T extends MessageLike>(
  message: T,
  log: DedupLog,
): T | null {
  const seen = new Set<string>();
  const kept: MessagePart[] = [];
  for (const part of message.content.toReversed()) {
    if (part.type === "toolCall") {
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
