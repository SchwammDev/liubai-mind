import { test } from "node:test";
import assert from "node:assert/strict";

import { register } from "./index.ts";
import type { RailsDeps } from "./index.ts";
import { RULE } from "../../engine/contract.ts";
import { nudgePhrasingHash } from "../../engine/contract.ts";
import type { RailReportLine } from "../../engine/contract.ts";

const ALL_RULE_NAMES = Object.values(RULE);
const TOGGLE_KEYS = ["LIUBAI_EVAL", "LIUBAI_RAILS_OFF", "LIUBAI_CC_DELTA_OFF", "LIUBAI_SHADOW_RULES", "LIUBAI_NUDGE_PHRASING"] as const;

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

type Delivered = Extract<RailReportLine, { type: "delivered" }>;

function registerAndCapture(env: Partial<Record<(typeof TOGGLE_KEYS)[number], string>>): Delivered[] {
  const reported: Delivered[] = [];
  const deps: RailsDeps = { logDedup: () => {}, report: (line) => reported.push(line as Delivered) };
  withEnv(env, () => register(fakePi(), deps));
  return reported;
}

function assertDeliveredOnce(reported: Delivered[], expected: Delivered): void {
  assert.deepEqual(reported, [expected]);
}

test("under LIUBAI_EVAL, registration stamps the nudge phrasing hash and every rule as live", () => {
  const reported = registerAndCapture({ LIUBAI_EVAL: "1", LIUBAI_NUDGE_PHRASING: '{"CC_NUDGE":{}}' }).map(
    (s) => ({ ...s, liveRules: [...s.liveRules].sort() }),
  );

  assertDeliveredOnce(reported, {
    type: "delivered",
    nudgePhrasingHash: nudgePhrasingHash('{"CC_NUDGE":{}}'),
    liveRules: [...ALL_RULE_NAMES].sort(),
    shadowRules: [],
  });
});

test("without LIUBAI_EVAL, registration writes no stamp", () => {
  const reported = registerAndCapture({ LIUBAI_NUDGE_PHRASING: '{"CC_NUDGE":{}}' });

  assert.deepEqual(reported, []);
});

test("nudgePhrasingHash is null when LIUBAI_NUDGE_PHRASING is unset", () => {
  const reported = registerAndCapture({ LIUBAI_EVAL: "1" });

  assert.equal(reported[0]?.nudgePhrasingHash, null);
});

test("LIUBAI_SHADOW_RULES moves the named rule from live into shadow", () => {
  const reported = registerAndCapture({ LIUBAI_EVAL: "1", LIUBAI_SHADOW_RULES: RULE.ccDelta });

  assert.deepEqual(reported[0]?.shadowRules, [RULE.ccDelta]);
  assert.equal(reported[0]?.liveRules.includes(RULE.ccDelta), false);
});

test("LIUBAI_CC_DELTA_OFF drops cc-delta from both live and shadow rules", () => {
  const reported = registerAndCapture({ LIUBAI_EVAL: "1", LIUBAI_CC_DELTA_OFF: "1", LIUBAI_SHADOW_RULES: RULE.ccDelta });

  assert.equal(reported[0]?.liveRules.includes(RULE.ccDelta), false);
  assert.equal(reported[0]?.shadowRules.includes(RULE.ccDelta), false);
});

test("LIUBAI_RAILS_OFF still stamps, but with both rule sets empty", () => {
  const reported = registerAndCapture({ LIUBAI_EVAL: "1", LIUBAI_RAILS_OFF: "1", LIUBAI_NUDGE_PHRASING: '{"CC_NUDGE":{}}' });

  assertDeliveredOnce(reported, { type: "delivered", nudgePhrasingHash: nudgePhrasingHash('{"CC_NUDGE":{}}'), liveRules: [], shadowRules: [] });
});
