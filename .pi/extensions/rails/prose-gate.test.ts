import { test } from "node:test";
import assert from "node:assert/strict";

import { stripFiller, cleanProse } from "./prose-gate.ts";

const assistantWith = (parts: any[]) => ({ role: "assistant", content: parts });

test("a sycophantic opener is dropped, its substance kept", () => {
  const cleaned = stripFiller("Great question! The cache lives in ~/.pi.");

  assert.equal(cleaned, "The cache lives in ~/.pi.");
});

test("a closing pleasantry is dropped", () => {
  const cleaned = stripFiller("Run the migration first. Let me know if you have any questions!");

  assert.equal(cleaned, "Run the migration first.");
});

test("a hedge preamble is stripped and its clause is promoted to the sentence", () => {
  const cleaned = stripFiller("It's worth noting that the gate runs on every message.");

  assert.equal(cleaned, "The gate runs on every message.");
});

test("prose carrying no filler passes through untouched", () => {
  const prose = "The rails block on edit and nudge on tool result.";

  assert.equal(stripFiller(prose), prose);
});

test("filler is matched regardless of case", () => {
  const cleaned = stripFiller("CERTAINLY. The flag defaults to off.");

  assert.equal(cleaned, "The flag defaults to off.");
});

test("a filler word inside a real word is left alone", () => {
  const prose = "Make sure of course-grained locking before the merge.";

  assert.equal(stripFiller(prose), prose);
});

test("only the text parts of an assistant message are rewritten", () => {
  const message = assistantWith([
    { type: "text", text: "Certainly. The flag defaults to off." },
    { type: "thinking", thinking: "Great question! still thinking" },
    { type: "toolCall", id: "1", name: "edit", arguments: {} },
  ]);

  const cleaned = cleanProse(message);

  assert.equal(cleaned.content[0].text, "The flag defaults to off.");
  assert.equal(cleaned.content[1].thinking, "Great question! still thinking");
  assert.deepEqual(cleaned.content[2], message.content[2]);
});

test("a non-assistant message is returned untouched", () => {
  const toolResult = { role: "toolResult", content: [{ type: "text", text: "Of course. ran it" }] };

  assert.equal(cleanProse(toolResult), toolResult);
});
