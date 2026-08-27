import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConditions } from "./conditions.ts";
import type { ConditionManifest } from "./eval-contract.ts";

const CONDITIONS_DIR = join(import.meta.dirname, "conditions");

function assertLoaded(result: ReturnType<typeof loadConditions>): asserts result is ConditionManifest[] {
  assert.ok(Array.isArray(result), "expected conditions to load");
}

function assertRejected(result: ReturnType<typeof loadConditions>): asserts result is { error: string } {
  assert.ok(!Array.isArray(result) && "error" in result, "expected conditions to be rejected");
}

function tempConditionsDir(): string {
  return mkdtempSync(join(tmpdir(), "eval-conditions-"));
}

function writeCondition(dir: string, filename: string, manifest: object): void {
  writeFileSync(join(dir, filename), JSON.stringify(manifest));
}

test("loadConditions_loads_all_committed_conditions", () => {
  const result = loadConditions(CONDITIONS_DIR);

  assertLoaded(result);
  const ids = result.map((c) => c.id).sort();
  assert.deepEqual(ids, ["coaching-v1", "control", "rails-default"]);
});

test("loadConditions_reads_control_env_from_its_manifest", () => {
  const result = loadConditions(CONDITIONS_DIR);

  assertLoaded(result);
  const control = result.find((c) => c.id === "control");
  assert.deepEqual(control?.env, { LIUBAI_RAILS_OFF: "1" });
});

test("loadConditions_rejects_duplicate_ids_across_files", () => {
  const dir = tempConditionsDir();
  writeCondition(dir, "a.json", { id: "dup", env: {} });
  writeCondition(dir, "b.json", { id: "dup", env: {} });

  const result = loadConditions(dir);

  assertRejected(result);
  assert.match(result.error, /dup/);
});

test("loadConditions_rejects_unknown_id_in_only_filter", () => {
  const result = loadConditions(CONDITIONS_DIR, ["nonexistent"]);

  assertRejected(result);
  assert.match(result.error, /nonexistent/);
});

test("loadConditions_filters_to_the_requested_ids", () => {
  const result = loadConditions(CONDITIONS_DIR, ["control"]);

  assertLoaded(result);
  assert.deepEqual(result.map((c) => c.id), ["control"]);
});

test("loadConditions_rejects_a_condition_with_an_invalid_phrasing_pack", () => {
  const dir = tempConditionsDir();
  mkdirSync(join(dir, "packs"));
  writeFileSync(join(dir, "packs", "pack.json"), "{ not json");
  writeCondition(dir, "broken-pack.json", { id: "broken-pack", env: {}, phrasingPack: "packs/pack.json" });

  const result = loadConditions(dir);

  assertRejected(result);
  assert.match(result.error, /broken-pack/);
});

test("loadConditions_accepts_a_condition_with_a_valid_phrasing_pack", () => {
  const dir = tempConditionsDir();
  mkdirSync(join(dir, "packs"));
  writeFileSync(join(dir, "packs", "pack.json"), '{"CC_NUDGE":{"python":{"first":"be terse","rest":"be terse"}}}');
  writeCondition(dir, "with-pack.json", { id: "with-pack", env: {}, phrasingPack: "packs/pack.json" });

  const result = loadConditions(dir);

  assertLoaded(result);
  assert.equal(result[0]?.phrasingPack, "packs/pack.json");
});
