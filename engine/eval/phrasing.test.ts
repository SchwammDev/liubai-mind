import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { validateNudgePhrasing } from "./phrasing.ts";
import type { NudgePhrasing } from "./phrasing.ts";
import { nudgePhrasingHash } from "../contract.ts";

function assertAccepted(result: ReturnType<typeof validateNudgePhrasing>): asserts result is { phrasing: NudgePhrasing } {
  assert.ok("phrasing" in result, `expected acceptance, got: ${"error" in result ? result.error : ""}`);
}

function assertRejected(result: ReturnType<typeof validateNudgePhrasing>): asserts result is { error: string } {
  assert.ok("error" in result, "expected rejection");
}

function nudgeEntry(): { first: string; rest: string } {
  return { first: "full guide for {name}", rest: "{name}: same" };
}

test("validateNudgePhrasing accepts a nudge phrasing overriding every known lang", () => {
  const result = validateNudgePhrasing(JSON.stringify({ CC_NUDGE: { python: nudgeEntry(), typescript: nudgeEntry(), cpp: nudgeEntry() } }));

  assertAccepted(result);
  assert.deepEqual(result.phrasing.CC_NUDGE, { python: nudgeEntry(), typescript: nudgeEntry(), cpp: nudgeEntry() });
});

test("validateNudgePhrasing accepts a nudge phrasing overriding only one lang", () => {
  const result = validateNudgePhrasing(JSON.stringify({ CC_NUDGE: { python: nudgeEntry() } }));

  assertAccepted(result);
  assert.deepEqual(result.phrasing.CC_NUDGE, { python: nudgeEntry() });
});

test("validateNudgePhrasing accepts a nudge phrasing with an empty CC_NUDGE", () => {
  const result = validateNudgePhrasing('{"CC_NUDGE":{}}');

  assertAccepted(result);
  assert.deepEqual(result.phrasing.CC_NUDGE, {});
});

test("validateNudgePhrasing accepts a nudge phrasing with only CC_DELTA_NUDGE", () => {
  const result = validateNudgePhrasing('{"CC_DELTA_NUDGE":"the file still carries the same decisions"}');

  assertAccepted(result);
  assert.equal(result.phrasing.CC_DELTA_NUDGE, "the file still carries the same decisions");
  assert.equal(result.phrasing.CC_NUDGE, undefined);
});

test("validateNudgePhrasing accepts a nudge phrasing with neither CC_NUDGE nor CC_DELTA_NUDGE", () => {
  const result = validateNudgePhrasing("{}");

  assertAccepted(result);
  assert.equal(result.phrasing.CC_NUDGE, undefined);
  assert.equal(result.phrasing.CC_DELTA_NUDGE, undefined);
});

test("validateNudgePhrasing accepts a nudge phrasing with both CC_NUDGE and CC_DELTA_NUDGE", () => {
  const result = validateNudgePhrasing(JSON.stringify({ CC_NUDGE: { python: nudgeEntry() }, CC_DELTA_NUDGE: "same decisions" }));

  assertAccepted(result);
  assert.deepEqual(result.phrasing.CC_NUDGE, { python: nudgeEntry() });
  assert.equal(result.phrasing.CC_DELTA_NUDGE, "same decisions");
});

test("validateNudgePhrasing rejects a non-string CC_DELTA_NUDGE", () => {
  const result = validateNudgePhrasing('{"CC_DELTA_NUDGE":42}');

  assertRejected(result);
  assert.match(result.error, /CC_DELTA_NUDGE must be a non-empty string/);
});

test("validateNudgePhrasing rejects an empty string CC_DELTA_NUDGE", () => {
  const result = validateNudgePhrasing('{"CC_DELTA_NUDGE":""}');

  assertRejected(result);
  assert.match(result.error, /CC_DELTA_NUDGE must be a non-empty string/);
});

test("validateNudgePhrasing rejects an unknown top-level key", () => {
  const result = validateNudgePhrasing(JSON.stringify({ CC_NUDGE: { python: nudgeEntry() }, EXTRA: true }));

  assertRejected(result);
  assert.match(result.error, /EXTRA/);
});

test("validateNudgePhrasing rejects the retired CC_ADVICE key", () => {
  const result = validateNudgePhrasing('{"CC_ADVICE":{"python":"a"}}');

  assertRejected(result);
  assert.match(result.error, /CC_ADVICE/);
});

test("validateNudgePhrasing rejects a non-object CC_NUDGE", () => {
  const result = validateNudgePhrasing('{"CC_NUDGE":"nope"}');

  assertRejected(result);
  assert.match(result.error, /CC_NUDGE must be an object/);
});

test("validateNudgePhrasing rejects an unknown lang key inside CC_NUDGE", () => {
  const result = validateNudgePhrasing(JSON.stringify({ CC_NUDGE: { klingon: nudgeEntry() } }));

  assertRejected(result);
  assert.match(result.error, /klingon/);
});

test("validateNudgePhrasing rejects a lang entry that is not an object", () => {
  const result = validateNudgePhrasing('{"CC_NUDGE":{"python":"just a string"}}');

  assertRejected(result);
  assert.match(result.error, /CC_NUDGE\.python/);
});

test("validateNudgePhrasing rejects a lang entry missing first", () => {
  const result = validateNudgePhrasing('{"CC_NUDGE":{"python":{"rest":"r"}}}');

  assertRejected(result);
  assert.match(result.error, /first/);
});

test("validateNudgePhrasing rejects a lang entry missing rest", () => {
  const result = validateNudgePhrasing('{"CC_NUDGE":{"python":{"first":"f"}}}');

  assertRejected(result);
  assert.match(result.error, /rest/);
});

test("validateNudgePhrasing rejects a non-string first", () => {
  const result = validateNudgePhrasing('{"CC_NUDGE":{"python":{"first":42,"rest":"r"}}}');

  assertRejected(result);
  assert.match(result.error, /first/);
});

test("validateNudgePhrasing rejects an unknown key inside a lang entry", () => {
  const result = validateNudgePhrasing('{"CC_NUDGE":{"python":{"first":"f","rest":"r","middle":"m"}}}');

  assertRejected(result);
  assert.match(result.error, /middle/);
});

test("validateNudgePhrasing rejects malformed json", () => {
  const result = validateNudgePhrasing("{ not json");

  assertRejected(result);
  assert.match(result.error, /invalid json/);
});

test("validateNudgePhrasing rejects a nudge phrasing that is not an object", () => {
  const result = validateNudgePhrasing('["CC_NUDGE"]');

  assertRejected(result);
  assert.match(result.error, /nudge phrasing must be a JSON object/);
});

test("nudgePhrasingHash is stable for identical bytes", () => {
  const first = nudgePhrasingHash('{"CC_NUDGE":{}}');
  const second = nudgePhrasingHash('{"CC_NUDGE":{}}');

  assert.equal(first, second);
  assert.equal(first, createHash("sha256").update('{"CC_NUDGE":{}}').digest("hex"));
});

test("nudgePhrasingHash differs for different bytes", () => {
  const first = nudgePhrasingHash('{"CC_NUDGE":{}}');
  const second = nudgePhrasingHash('{"CC_NUDGE":{"python":{"first":"f","rest":"r"}}}');

  assert.notEqual(first, second);
});

test("nudgePhrasingHash of null bytes is null", () => {
  assert.equal(nudgePhrasingHash(null), null);
});
