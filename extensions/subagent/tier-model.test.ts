import { test } from "node:test";
import assert from "node:assert/strict";

import type { ComplexityMap } from "./child.ts";
import { resolveTier, resolveTiers, tableProblems, type CatalogModel, type ModelCatalog } from "./tier-model.ts";

const model = (provider: string, id: string, api = "openai-responses"): CatalogModel => ({ provider, id, api });

const catalogOf = (...models: CatalogModel[]): ModelCatalog => ({
  find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
  getAll: () => [...models],
  hasConfiguredAuth: () => true,
});

const errorFrom = (resolution: ReturnType<typeof resolveTier>): string => {
  assert.equal(resolution.kind, "error", "expected the tier to be rejected");
  return resolution.kind === "error" ? resolution.message : "";
};

const AMBIGUOUS_CATALOG = catalogOf(model("opencode", "kimi-k2.6"), model("opencode-go", "kimi-k2.6"));

test("a provider-qualified id resolves to the catalog entry carrying its api", () => {
  const catalog = catalogOf(model("aqueduct", "glm-5.2", "anthropic-messages"));

  const resolution = resolveTier("hard", "aqueduct/glm-5.2", catalog);

  assert.deepEqual(resolution, {
    kind: "resolved",
    tier: "hard",
    reference: "aqueduct/glm-5.2",
    model: model("aqueduct", "glm-5.2", "anthropic-messages"),
  });
});

test("only the first slash separates provider from id, so ids may contain slashes", () => {
  const catalog = catalogOf(model("openrouter", "moonshotai/kimi-k2.6"));

  const resolution = resolveTier("medium", "openrouter/moonshotai/kimi-k2.6", catalog);

  assert.equal(resolution.kind, "resolved");
});

test("a bare id is rejected naming the tier and every provider that lists it", () => {
  const message = errorFrom(resolveTier("hard", "kimi-k2.6", AMBIGUOUS_CATALOG));

  assert.match(message, /"hard"/);
  assert.match(message, /opencode, opencode-go/);
});

test("a bare id listed by one provider is rejected with that provider as the fix", () => {
  const catalog = catalogOf(model("opencode", "kimi-k2.6"));

  assert.match(errorFrom(resolveTier("easy", "kimi-k2.6", catalog)), /"opencode\/kimi-k2\.6"/);
});

test("a bare id no provider lists is rejected saying nothing lists it", () => {
  assert.match(errorFrom(resolveTier("trivial", "invented-model", AMBIGUOUS_CATALOG)), /No provider lists/);
});

test("an unresolvable model id is rejected naming the tier, the provider and the id", () => {
  const catalog = catalogOf(model("aqueduct", "glm-5.2"));

  const message = errorFrom(resolveTier("hard", "aqueduct/glm-9.9", catalog));

  assert.match(message, /"hard"/);
  assert.match(message, /aqueduct/);
  assert.match(message, /glm-9\.9/);
});

test("a model id differing only in case is rejected, since the catalog matches exactly", () => {
  const catalog = catalogOf(model("aqueduct", "glm-5.2"));

  assert.match(errorFrom(resolveTier("hard", "aqueduct/GLM-5.2", catalog)), /case/);
});

test("an unresolvable model id lists the provider's real ids, capped", () => {
  const ids = Array.from({ length: 10 }, (_, i) => `glm-${i}`);
  const catalog = catalogOf(...ids.map((id) => model("aqueduct", id)));

  const message = errorFrom(resolveTier("hard", "aqueduct/glm-9.9", catalog));

  assert.match(message, /glm-0, glm-1, glm-2, glm-3, glm-4, glm-5, glm-6, glm-7 \(\+2 more\)/);
});

test("an unknown provider is rejected naming it as unknown", () => {
  assert.match(errorFrom(resolveTier("hard", "nosuch/model-x", AMBIGUOUS_CATALOG)), /No provider is named "nosuch"/);
});

test("a self-prefixed model id is rejected suggesting the doubled reference", () => {
  const catalog = catalogOf(model("nvidia", "nvidia/nemotron-3"));

  const message = errorFrom(resolveTier("hard", "nvidia/nemotron-3", catalog));

  assert.match(message, /"nvidia\/nvidia\/nemotron-3"/);
});

const MIXED_TABLE: ComplexityMap = {
  trivial: "opencode/kimi-k2.6",
  easy: "kimi-k2.6",
  medium: "opencode-go/kimi-k2.6",
  hard: "opencode/absent",
};

const SOUND_TABLE: ComplexityMap = {
  trivial: "opencode/kimi-k2.6",
  easy: "opencode/kimi-k2.6",
  medium: "opencode-go/kimi-k2.6",
  hard: "opencode-go/kimi-k2.6",
};

test("resolving the table reports one outcome per tier in tier order", () => {
  const kinds = resolveTiers(MIXED_TABLE, AMBIGUOUS_CATALOG).map((r) => `${r.tier}:${r.kind}`);

  assert.deepEqual(kinds, ["trivial:resolved", "easy:error", "medium:resolved", "hard:error"]);
});

test("a table whose every tier resolves reports no problems", () => {
  assert.equal(tableProblems(SOUND_TABLE, AMBIGUOUS_CATALOG), undefined);
});

test("a table reports each unresolvable tier so the whole edit is known at once", () => {
  const problems = tableProblems(MIXED_TABLE, AMBIGUOUS_CATALOG) ?? "";

  assert.match(problems, /"easy"/);
  assert.match(problems, /"hard"/);
});

test("an empty catalog reports no problems, since it may simply not have loaded", () => {
  const empty = catalogOf();

  assert.equal(tableProblems(MIXED_TABLE, empty), undefined);
});
