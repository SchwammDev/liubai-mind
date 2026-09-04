import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTreatments } from "./treatments.ts";
import type { TreatmentManifest } from "./eval-contract.ts";

const TREATMENTS_DIR = join(import.meta.dirname, "treatments");

function assertLoaded(result: ReturnType<typeof loadTreatments>): asserts result is TreatmentManifest[] {
  assert.ok(Array.isArray(result), "expected treatments to load");
}

function assertRejected(result: ReturnType<typeof loadTreatments>): asserts result is { error: string } {
  assert.ok(!Array.isArray(result) && "error" in result, "expected treatments to be rejected");
}

function tempTreatmentsDir(): string {
  return mkdtempSync(join(tmpdir(), "eval-treatments-"));
}

function writeTreatment(dir: string, filename: string, manifest: object): void {
  writeFileSync(join(dir, filename), JSON.stringify(manifest));
}

test("loadTreatments_loads_all_committed_treatments", () => {
  const result = loadTreatments(TREATMENTS_DIR);

  assertLoaded(result);
  const ids = result.map((c) => c.id).sort();
  assert.deepEqual(ids, ["bare-metric-v1", "cc-delta-numbered-prompt", "cc-delta-numberless", "cc-delta-numberless-prompt", "cc-delta-off", "cc-delta-shadow", "coaching-v1", "control", "rails-default"]);
});

test("loadTreatments_reads_control_env_from_its_manifest", () => {
  const result = loadTreatments(TREATMENTS_DIR);

  assertLoaded(result);
  const control = result.find((c) => c.id === "control");
  assert.deepEqual(control?.env, { LIUBAI_RAILS_OFF: "1" });
});

test("loadTreatments_rejects_duplicate_ids_across_files", () => {
  const dir = tempTreatmentsDir();
  writeTreatment(dir, "a.json", { id: "dup", env: {} });
  writeTreatment(dir, "b.json", { id: "dup", env: {} });

  const result = loadTreatments(dir);

  assertRejected(result);
  assert.match(result.error, /dup/);
});

test("loadTreatments_rejects_unknown_id_in_only_filter", () => {
  const result = loadTreatments(TREATMENTS_DIR, ["nonexistent"]);

  assertRejected(result);
  assert.match(result.error, /nonexistent/);
});

test("loadTreatments_filters_to_the_requested_ids", () => {
  const result = loadTreatments(TREATMENTS_DIR, ["control"]);

  assertLoaded(result);
  assert.deepEqual(result.map((c) => c.id), ["control"]);
});

test("loadTreatments_rejects_a_treatment_with_an_invalid_phrasing_pack", () => {
  const dir = tempTreatmentsDir();
  mkdirSync(join(dir, "packs"));
  writeFileSync(join(dir, "packs", "pack.json"), "{ not json");
  writeTreatment(dir, "broken-pack.json", { id: "broken-pack", env: {}, phrasingPack: "packs/pack.json" });

  const result = loadTreatments(dir);

  assertRejected(result);
  assert.match(result.error, /broken-pack/);
});

test("loadTreatments_accepts_a_treatment_with_a_valid_phrasing_pack", () => {
  const dir = tempTreatmentsDir();
  mkdirSync(join(dir, "packs"));
  writeFileSync(join(dir, "packs", "pack.json"), '{"CC_NUDGE":{"python":{"first":"be terse","rest":"be terse"}}}');
  writeTreatment(dir, "with-pack.json", { id: "with-pack", env: {}, phrasingPack: "packs/pack.json" });

  const result = loadTreatments(dir);

  assertLoaded(result);
  assert.equal(result[0]?.phrasingPack, "packs/pack.json");
});

test("loadTreatments_reads_expectedZeroFirings_true_from_its_manifest", () => {
  const dir = tempTreatmentsDir();
  writeTreatment(dir, "zero.json", { id: "zero-firings", env: {}, expectedZeroFirings: true });

  const result = loadTreatments(dir);

  assertLoaded(result);
  assert.equal(result[0]?.expectedZeroFirings, true);
});

test("loadTreatments_leaves_expectedZeroFirings_undefined_when_the_manifest_omits_it", () => {
  const dir = tempTreatmentsDir();
  writeTreatment(dir, "plain.json", { id: "plain", env: {} });

  const result = loadTreatments(dir);

  assertLoaded(result);
  assert.equal(result[0]?.expectedZeroFirings, undefined);
});

test("loadTreatments_rejects_a_non_boolean_expectedZeroFirings", () => {
  const dir = tempTreatmentsDir();
  writeTreatment(dir, "bad.json", { id: "bad-zero", env: {}, expectedZeroFirings: "true" });

  const result = loadTreatments(dir);

  assertRejected(result);
  assert.match(result.error, /expectedZeroFirings must be a boolean/);
});

test("loadTreatments_leaves_delivery_undefined_when_the_manifest_omits_it", () => {
  const dir = tempTreatmentsDir();
  writeTreatment(dir, "plain.json", { id: "plain", env: {} });

  const result = loadTreatments(dir);

  assertLoaded(result);
  assert.equal(result[0]?.delivery, undefined);
});

test("loadTreatments_reads_delivery_prompt_from_a_treatment_that_closes_the_live_rail", () => {
  const dir = tempTreatmentsDir();
  mkdirSync(join(dir, "packs"));
  writeFileSync(join(dir, "packs", "pack.json"), '{"CC_DELTA_NUDGE":"nudge text"}');
  writeTreatment(dir, "prompt-carried.json", {
    id: "prompt-carried",
    delivery: "prompt",
    env: { LIUBAI_RAILS_OFF: "1" },
    phrasingPack: "packs/pack.json",
  });

  const result = loadTreatments(dir);

  assertLoaded(result);
  assert.equal(result[0]?.delivery, "prompt");
});

test("loadTreatments_rejects_a_prompt_delivery_treatment_that_carries_no_phrasing_pack", () => {
  const dir = tempTreatmentsDir();
  writeTreatment(dir, "unpinned-prompt.json", { id: "unpinned-prompt", delivery: "prompt", env: { LIUBAI_RAILS_OFF: "1" } });

  const result = loadTreatments(dir);

  assertRejected(result);
  assert.match(result.error, /phrasingPack/);
  assert.match(result.error, /drift/);
});

test("loadTreatments_reads_the_pinned_pack_for_the_cc_delta_numbered_prompt_treatment", () => {
  const result = loadTreatments(TREATMENTS_DIR);

  assertLoaded(result);
  const treatment = result.find((c) => c.id === "cc-delta-numbered-prompt");
  assert.equal(treatment?.phrasingPack, "packs/cc-delta-numbered.json");
});

test("loadTreatments_rejects_a_delivery_value_that_is_neither_prompt_nor_rail", () => {
  const dir = tempTreatmentsDir();
  writeTreatment(dir, "bad-delivery.json", { id: "bad-delivery", env: {}, delivery: "carrier-pigeon" });

  const result = loadTreatments(dir);

  assertRejected(result);
  assert.match(result.error, /bad-delivery\.json/);
  assert.match(result.error, /carrier-pigeon/);
});

test("loadTreatments_rejects_a_prompt_delivery_treatment_that_leaves_the_live_rail_open", () => {
  const dir = tempTreatmentsDir();
  writeTreatment(dir, "leaky-prompt.json", { id: "leaky-prompt", delivery: "prompt", env: {} });

  const result = loadTreatments(dir);

  assertRejected(result);
  assert.match(result.error, /LIUBAI_RAILS_OFF/);
});
