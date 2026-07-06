import { test } from "node:test";
import assert from "node:assert/strict";

import { injectWebSearch } from "./web-search.ts";

const aqueductResponses = { provider: "aqueduct", api: "openai-responses" };
const payload = (over: any = {}) => ({ model: "qwen-3.5-397b", input: [], ...over });

test("an aqueduct responses request gains the server-side web_search tool", () => {
  const result = injectWebSearch(payload(), aqueductResponses);

  assert.deepEqual(result?.tools, [{ type: "web_search" }]);
});

test("existing function tools survive with web_search appended after them", () => {
  const bash = { type: "function", name: "bash" };

  const result = injectWebSearch(payload({ tools: [bash] }), aqueductResponses);

  assert.deepEqual(result?.tools, [bash, { type: "web_search" }]);
});

test("a request to another provider passes through untouched", () => {
  const result = injectWebSearch(payload(), { provider: "openai", api: "openai-responses" });

  assert.equal(result, undefined);
});

test("an aqueduct chat-completions request passes through untouched", () => {
  const result = injectWebSearch(payload(), { provider: "aqueduct", api: "openai-completions" });

  assert.equal(result, undefined);
});

test("a payload that already carries web_search is left unchanged", () => {
  const result = injectWebSearch(payload({ tools: [{ type: "web_search" }] }), aqueductResponses);

  assert.equal(result, undefined);
});

test("the original payload is not mutated", () => {
  const original = payload({ tools: [{ type: "function", name: "bash" }] });

  injectWebSearch(original, aqueductResponses);

  assert.deepEqual(original.tools, [{ type: "function", name: "bash" }]);
});
