import { test } from "node:test";
import assert from "node:assert/strict";

import { withoutDuplicateToolCalls, type MessageLike, type MessagePart } from "./duplicate-delivery.ts";

const toolCall = (id: string, marker: string): MessagePart => ({
  type: "toolCall",
  id,
  name: "bash",
  arguments: { marker },
});

const MESSAGE_WITH_DUPLICATE_IDS: MessageLike = {
  role: "assistant",
  content: [
    toolCall("call-A", "early"),
    toolCall("call-B", "early"),
    { type: "thinking", thinking: "t" },
    toolCall("call-A", "late"),
    toolCall("call-B", "late"),
  ],
};

function partMarkers(message: MessageLike | null): Array<[string, unknown]> | undefined {
  return message?.content.map((part: any) => [part.type, part.arguments?.marker]);
}

test("a message carrying the same tool call id twice keeps only the last copy", () => {
  const logs: any[] = [];

  const deduped = withoutDuplicateToolCalls(MESSAGE_WITH_DUPLICATE_IDS, (entry) => logs.push(entry));

  assert.deepEqual(partMarkers(deduped), [["thinking", undefined], ["toolCall", "late"], ["toolCall", "late"]]);
  assert.equal(logs.filter((entry) => entry.kind === "duplicate-id").length, 2);
});

test("a message without duplicate tool calls is reported unchanged", () => {
  const message: MessageLike = {
    role: "assistant",
    content: [toolCall("call-A", "only"), toolCall("call-B", "only")],
  };

  assert.equal(withoutDuplicateToolCalls(message, () => {}), null);
});
