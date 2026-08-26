import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { packHash, validatePack } from "./phrasing.ts";

function assertAccepted(result: ReturnType<typeof validatePack>): asserts result is { pack: { CC_NUDGE: Record<string, { first: string; rest: string }> } } {
  assert.ok("pack" in result, `expected acceptance, got: ${"error" in result ? result.error : ""}`);
}

function assertRejected(result: ReturnType<typeof validatePack>): asserts result is { error: string } {
  assert.ok("error" in result, "expected rejection");
}

function nudgeEntry(): { first: string; rest: string } {
  return { first: "full guide for {name}", rest: "{name}: same" };
}

test("validatePack accepts a pack overriding every known lang", () => {
  const result = validatePack(JSON.stringify({ CC_NUDGE: { python: nudgeEntry(), typescript: nudgeEntry(), cpp: nudgeEntry() } }));

  assertAccepted(result);
  assert.deepEqual(result.pack.CC_NUDGE, { python: nudgeEntry(), typescript: nudgeEntry(), cpp: nudgeEntry() });
});

test("validatePack accepts a pack overriding only one lang", () => {
  const result = validatePack(JSON.stringify({ CC_NUDGE: { python: nudgeEntry() } }));

  assertAccepted(result);
  assert.deepEqual(result.pack.CC_NUDGE, { python: nudgeEntry() });
});

test("validatePack accepts a pack with an empty CC_NUDGE", () => {
  const result = validatePack('{"CC_NUDGE":{}}');

  assertAccepted(result);
  assert.deepEqual(result.pack.CC_NUDGE, {});
});

test("validatePack rejects an unknown top-level key", () => {
  const result = validatePack(JSON.stringify({ CC_NUDGE: { python: nudgeEntry() }, EXTRA: true }));

  assertRejected(result);
  assert.match(result.error, /EXTRA/);
});

test("validatePack rejects the retired CC_ADVICE key", () => {
  const result = validatePack('{"CC_ADVICE":{"python":"a"}}');

  assertRejected(result);
  assert.match(result.error, /CC_ADVICE/);
});

test("validatePack rejects a non-object CC_NUDGE", () => {
  const result = validatePack('{"CC_NUDGE":"nope"}');

  assertRejected(result);
  assert.match(result.error, /CC_NUDGE must be an object/);
});

test("validatePack rejects an unknown lang key inside CC_NUDGE", () => {
  const result = validatePack(JSON.stringify({ CC_NUDGE: { klingon: nudgeEntry() } }));

  assertRejected(result);
  assert.match(result.error, /klingon/);
});

test("validatePack rejects a lang entry that is not an object", () => {
  const result = validatePack('{"CC_NUDGE":{"python":"just a string"}}');

  assertRejected(result);
  assert.match(result.error, /CC_NUDGE\.python/);
});

test("validatePack rejects a lang entry missing first", () => {
  const result = validatePack('{"CC_NUDGE":{"python":{"rest":"r"}}}');

  assertRejected(result);
  assert.match(result.error, /first/);
});

test("validatePack rejects a lang entry missing rest", () => {
  const result = validatePack('{"CC_NUDGE":{"python":{"first":"f"}}}');

  assertRejected(result);
  assert.match(result.error, /rest/);
});

test("validatePack rejects a non-string first", () => {
  const result = validatePack('{"CC_NUDGE":{"python":{"first":42,"rest":"r"}}}');

  assertRejected(result);
  assert.match(result.error, /first/);
});

test("validatePack rejects an unknown key inside a lang entry", () => {
  const result = validatePack('{"CC_NUDGE":{"python":{"first":"f","rest":"r","middle":"m"}}}');

  assertRejected(result);
  assert.match(result.error, /middle/);
});

test("validatePack rejects malformed json", () => {
  const result = validatePack("{ not json");

  assertRejected(result);
  assert.match(result.error, /invalid json/);
});

test("validatePack rejects a pack that is not an object", () => {
  const result = validatePack('["CC_NUDGE"]');

  assertRejected(result);
  assert.match(result.error, /pack must be a JSON object/);
});

test("packHash is stable for identical bytes", () => {
  const first = packHash('{"CC_NUDGE":{}}');
  const second = packHash('{"CC_NUDGE":{}}');

  assert.equal(first, second);
  assert.equal(first, createHash("sha256").update('{"CC_NUDGE":{}}').digest("hex"));
});

test("packHash differs for different bytes", () => {
  const first = packHash('{"CC_NUDGE":{}}');
  const second = packHash('{"CC_NUDGE":{"python":{"first":"f","rest":"r"}}}');

  assert.notEqual(first, second);
});

test("packHash of null bytes is null", () => {
  assert.equal(packHash(null), null);
});
