import { test } from "node:test";
import assert from "node:assert/strict";

import { decisionPoints } from "./decision-points.ts";

function fn(cc: number): { cyclomaticComplexity: number } {
  return { cyclomaticComplexity: cc };
}

test("decisionPoints_sums_cc_minus_function_count", () => {
  const result = decisionPoints([fn(3), fn(5), fn(2)]);

  assert.equal(result, (3 + 5 + 2) - 3);
});

test("decisionPoints_of_empty_list_is_zero", () => {
  const result = decisionPoints([]);

  assert.equal(result, 0);
});
