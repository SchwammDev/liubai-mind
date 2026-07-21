import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bashKey,
  writeKey,
  editKey,
  blockReason,
  bashMatchesDedup,
  type DedupState,
} from "./dedup.ts";

test("bashKey is equal for commands differing only by surrounding whitespace", () => {
  assert.equal(bashKey("  gh issue comment 8  "), bashKey("gh issue comment 8"));
});

test("bashKey differs when the command body differs", () => {
  assert.notEqual(bashKey("gh issue comment 8 --body x"), bashKey("gh issue comment 8 --body y"));
});

test("writeKey is equal for the same path and content", () => {
  assert.equal(writeKey("a.txt", "hi"), writeKey("a.txt", "hi"));
});

test("writeKey differs for the same path and different content", () => {
  assert.notEqual(writeKey("a.txt", "hi"), writeKey("a.txt", "bye"));
});

test("writeKey differs for the same content and different path", () => {
  assert.notEqual(writeKey("a.txt", "hi"), writeKey("b.txt", "hi"));
});

test("editKey differs between one edit and two edits", () => {
  const one = [{ oldText: "a", newText: "b" }];
  const two = [
    { oldText: "a", newText: "b" },
    { oldText: "c", newText: "d" },
  ];

  assert.notEqual(editKey("a.txt", one), editKey("a.txt", two));
});

test("editKey differs when oldText changes", () => {
  const e1 = [{ oldText: "a", newText: "b" }];
  const e2 = [{ oldText: "x", newText: "b" }];

  assert.notEqual(editKey("a.txt", e1), editKey("a.txt", e2));
});

for (const tool of ["bash", "write", "edit"]) {
  test(`blockReason for ${tool} teaches that the call already succeeded and must not be retried`, () => {
    const reason = blockReason(tool);

    assert.match(reason, /already succeeded this session/);
    assert.match(reason, /re-issue blocked/);
    assert.match(reason, /Do not retry/);
    assert.match(reason, new RegExp(tool));
  });
}

test("bashMatchesDedup returns true for a command matching a pattern", () => {
  const patterns = ["\\bgh\\s+(issue|pr)\\s+comment\\b"];

  assert.equal(bashMatchesDedup("gh issue comment 8 --body x", patterns), true);
});

test("bashMatchesDedup returns false for an unmatched command", () => {
  const patterns = ["\\bgh\\s+(issue|pr)\\s+comment\\b"];

  assert.equal(bashMatchesDedup("git status", patterns), false);
});

test("bashMatchesDedup respects regex word boundaries", () => {
  const patterns = ["\\bgh\\s+(issue|pr)\\s+comment\\b"];

  assert.equal(bashMatchesDedup("gh issue view 8", patterns), false);
});

test("a command recorded on success blocks an identical re-issue", () => {
  const seen: DedupState = new Set<string>();
  const cmd = "gh issue comment 8 --body x";
  const key = bashKey(cmd);

  seen.add(key);

  assert.equal(seen.has(key), true);
});

test("a write recorded on success blocks an identical re-issue", () => {
  const seen: DedupState = new Set<string>();
  const key = writeKey("a.txt", "hi");

  seen.add(key);

  assert.equal(seen.has(key), true);
});

test("an edit recorded on success blocks an identical re-issue", () => {
  const seen: DedupState = new Set<string>();
  const key = editKey("a.txt", [{ oldText: "a", newText: "b" }]);

  seen.add(key);

  assert.equal(seen.has(key), true);
});
