import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "./index.ts";
import type { RailsDeps } from "./index.ts";
import { RULE } from "../../engine/contract.ts";
import { packHash } from "../../engine/contract.ts";

const ALL_RULE_NAMES = Object.values(RULE);
const TOGGLE_KEYS = ["LIUBAI_EVAL", "LIUBAI_RAILS_OFF", "LIUBAI_CC_DELTA_OFF", "LIUBAI_SHADOW_RULES", "LIUBAI_PHRASING_PACK"] as const;

function fakePi() {
  return { on: () => {}, registerTool: () => {} } as any;
}

function withEnv<T>(env: Partial<Record<(typeof TOGGLE_KEYS)[number], string>>, fn: () => T): T {
  const saved = new Map(TOGGLE_KEYS.map((key) => [key, process.env[key]]));
  for (const key of TOGGLE_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const key of TOGGLE_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type DeliveredStamp = { packHash: string | null; liveRules: string[]; shadowRules: string[] };

function registerAndCapture(env: Partial<Record<(typeof TOGGLE_KEYS)[number], string>>): DeliveredStamp[] {
  const stamps: DeliveredStamp[] = [];
  const deps: RailsDeps = { logDedup: () => {}, writeDelivered: (stamp) => stamps.push(stamp) };
  withEnv(env, () => register(fakePi(), deps));
  return stamps;
}

function assertDeliveredOnce(stamps: DeliveredStamp[], expected: DeliveredStamp): void {
  assert.deepEqual(stamps, [expected]);
}

test("under LIUBAI_EVAL, registration stamps the pack hash and every rule as live", () => {
  const stamps = registerAndCapture({ LIUBAI_EVAL: "1", LIUBAI_PHRASING_PACK: '{"CC_NUDGE":{}}' }).map(
    (s) => ({ ...s, liveRules: [...s.liveRules].sort() }),
  );

  assertDeliveredOnce(stamps, {
    packHash: packHash('{"CC_NUDGE":{}}'),
    liveRules: [...ALL_RULE_NAMES].sort(),
    shadowRules: [],
  });
});

test("without LIUBAI_EVAL, registration writes no stamp", () => {
  const stamps = registerAndCapture({ LIUBAI_PHRASING_PACK: '{"CC_NUDGE":{}}' });

  assert.deepEqual(stamps, []);
});

test("packHash is null when LIUBAI_PHRASING_PACK is unset", () => {
  const stamps = registerAndCapture({ LIUBAI_EVAL: "1" });

  assert.equal(stamps[0]?.packHash, null);
});

test("LIUBAI_SHADOW_RULES moves the named rule from live into shadow", () => {
  const stamps = registerAndCapture({ LIUBAI_EVAL: "1", LIUBAI_SHADOW_RULES: RULE.ccDelta });

  assert.deepEqual(stamps[0]?.shadowRules, [RULE.ccDelta]);
  assert.equal(stamps[0]?.liveRules.includes(RULE.ccDelta), false);
});

test("LIUBAI_CC_DELTA_OFF drops cc-delta from both live and shadow rules", () => {
  const stamps = registerAndCapture({ LIUBAI_EVAL: "1", LIUBAI_CC_DELTA_OFF: "1", LIUBAI_SHADOW_RULES: RULE.ccDelta });

  assert.equal(stamps[0]?.liveRules.includes(RULE.ccDelta), false);
  assert.equal(stamps[0]?.shadowRules.includes(RULE.ccDelta), false);
});

test("LIUBAI_RAILS_OFF still stamps, but with both rule sets empty", () => {
  const stamps = registerAndCapture({ LIUBAI_EVAL: "1", LIUBAI_RAILS_OFF: "1", LIUBAI_PHRASING_PACK: '{"CC_NUDGE":{}}' });

  assertDeliveredOnce(stamps, { packHash: packHash('{"CC_NUDGE":{}}'), liveRules: [], shadowRules: [] });
});
