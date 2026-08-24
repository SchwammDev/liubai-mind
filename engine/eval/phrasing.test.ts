import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { packHash, validatePack } from "./phrasing.ts";

function assertAccepted(result: ReturnType<typeof validatePack>): asserts result is { pack: { CC_ADVICE: Record<string, string> } } {
  assert.ok("pack" in result, "expected pack to be accepted");
}

function assertRejected(result: ReturnType<typeof validatePack>): asserts result is { error: string } {
  assert.ok("error" in result, "expected pack to be rejected");
}

test("validatePack accepts a pack overriding every known lang", () => {
  const result = validatePack('{"CC_ADVICE":{"python":"a","typescript":"b","cpp":"c"}}');

  assertAccepted(result);
  assert.deepEqual(result.pack.CC_ADVICE, { python: "a", typescript: "b", cpp: "c" });
});

test("validatePack accepts a pack overriding only one lang", () => {
  const result = validatePack('{"CC_ADVICE":{"python":"a"}}');

  assertAccepted(result);
  assert.deepEqual(result.pack.CC_ADVICE, { python: "a" });
});

test("validatePack accepts a pack with an empty CC_ADVICE", () => {
  const result = validatePack('{"CC_ADVICE":{}}');

  assertAccepted(result);
  assert.deepEqual(result.pack.CC_ADVICE, {});
});

test("validatePack rejects an unknown top-level key", () => {
  const result = validatePack('{"CC_ADVICE":{"python":"a"},"EXTRA":true}');

  assertRejected(result);
  assert.match(result.error, /EXTRA/);
});

test("validatePack rejects a non-object CC_ADVICE", () => {
  const result = validatePack('{"CC_ADVICE":"nope"}');

  assertRejected(result);
});

test("validatePack rejects an unknown lang key inside CC_ADVICE", () => {
  const result = validatePack('{"CC_ADVICE":{"klingon":"a"}}');

  assertRejected(result);
  assert.match(result.error, /klingon/);
});

test("validatePack rejects a non-string advice value", () => {
  const result = validatePack('{"CC_ADVICE":{"python":42}}');

  assertRejected(result);
  assert.match(result.error, /python/);
});

test("validatePack rejects invalid json with an error explaining why", () => {
  const result = validatePack("{ not json");

  assertRejected(result);
  assert.match(result.error, /json/i);
});

test("packHash is stable for identical bytes", () => {
  const first = packHash('{"CC_ADVICE":{"python":"a"}}');
  const second = packHash('{"CC_ADVICE":{"python":"a"}}');

  assert.equal(first, second);
  assert.equal(first, createHash("sha256").update('{"CC_ADVICE":{"python":"a"}}').digest("hex"));
});

test("packHash differs for different bytes", () => {
  const first = packHash('{"CC_ADVICE":{"python":"a"}}');
  const second = packHash('{"CC_ADVICE":{"python":"b"}}');

  assert.notEqual(first, second);
});

test("packHash is null for null input", () => {
  const result = packHash(null);

  assert.equal(result, null);
});
