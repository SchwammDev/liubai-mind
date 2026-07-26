import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  injectWebSearch,
  loadWebSearchConfig,
  searchAvailability,
  SEARCH_TOOL_BY_API,
  type SearchTool,
} from "./web-search.ts";

const aqueductResponses = { provider: "aqueduct", api: "openai-responses" };
const allowAqueduct = ["aqueduct"];
const payload = (over: any = {}) => ({ model: "qwen-3.5-397b", input: [], ...over });

test("an aqueduct responses request gains the server-side web_search tool", () => {
  const result = injectWebSearch(payload(), aqueductResponses, allowAqueduct);

  assert.deepEqual(result?.tools, [{ type: "web_search" }]);
});

test("existing function tools survive with web_search appended after them", () => {
  const bash = { type: "function", name: "bash" };

  const result = injectWebSearch(payload({ tools: [bash] }), aqueductResponses, allowAqueduct);

  assert.deepEqual(result?.tools, [bash, { type: "web_search" }]);
});

test("a provider outside the allowlist passes through untouched", () => {
  const result = injectWebSearch(payload(), { provider: "openai", api: "openai-responses" }, allowAqueduct);

  assert.equal(result, undefined);
});

test("an aqueduct chat-completions request passes through untouched", () => {
  const result = injectWebSearch(payload(), { provider: "aqueduct", api: "openai-completions" }, allowAqueduct);

  assert.equal(result, undefined);
});

test("a payload that already carries web_search is left unchanged", () => {
  const result = injectWebSearch(payload({ tools: [{ type: "web_search" }] }), aqueductResponses, allowAqueduct);

  assert.equal(result, undefined);
});

test("a payload that is not a request object passes through untouched", () => {
  const result = injectWebSearch("not-a-request", aqueductResponses, allowAqueduct);

  assert.equal(result, undefined);
});

test("the original payload is not mutated", () => {
  const original = payload({ tools: [{ type: "function", name: "bash" }] });

  injectWebSearch(original, aqueductResponses, allowAqueduct);

  assert.deepEqual(original.tools, [{ type: "function", name: "bash" }]);
});

test("a second allowlisted provider also gains the tool", () => {
  const result = injectWebSearch(payload(), { provider: "tuwien-geo", api: "openai-responses" }, [
    "aqueduct",
    "tuwien-geo",
  ]);

  assert.deepEqual(result?.tools, [{ type: "web_search" }]);
});

test("an empty allowlist disables injection entirely", () => {
  const result = injectWebSearch(payload(), aqueductResponses, []);

  assert.equal(result, undefined);
});

test("an allowlisted provider on an api with no known tool shape gains nothing", () => {
  const result = injectWebSearch(payload(), { provider: "aqueduct", api: "anthropic-messages" }, allowAqueduct);

  assert.equal(result, undefined);
});

test("a payload whose tools carry an entry without a type still gains web_search", () => {
  const typeless = { name: "mystery" };

  const result = injectWebSearch(payload({ tools: [typeless] }), aqueductResponses, allowAqueduct);

  assert.deepEqual(result?.tools, [typeless, { type: "web_search" }]);
});

const GENAI_SEARCH = { googleSearch: {} };
const genaiApi = { provider: "aqueduct", api: "fake-genai" };

const withTypelessApi: Record<string, SearchTool> = {
  ...SEARCH_TOOL_BY_API,
  "fake-genai": {
    tool: GENAI_SEARCH,
    alreadyPresent: (tools) => tools.some((tool) => Object.hasOwn(tool as object, "googleSearch")),
  },
};

test("an api whose tool shape carries no type field is still injected", () => {
  const result = injectWebSearch(payload(), genaiApi, allowAqueduct, withTypelessApi);

  assert.deepEqual(result?.tools, [GENAI_SEARCH]);
});

test("an api's own already-present check suppresses a second injection", () => {
  const result = injectWebSearch(payload({ tools: [GENAI_SEARCH] }), genaiApi, allowAqueduct, withTypelessApi);

  assert.equal(result, undefined);
});

const refusalFor = (model: { provider: string; api: string }): string => {
  const availability = searchAvailability(model, allowAqueduct);
  assert.equal(availability.ok, false, "expected search to be unavailable");
  return availability.ok ? "" : availability.reason;
};

test("an allowlisted provider on a supported api can search", () => {
  assert.deepEqual(searchAvailability(aqueductResponses, allowAqueduct), { ok: true });
});

test("a provider outside the allowlist cannot search, and the reason names the allowlist", () => {
  assert.match(refusalFor({ provider: "openai", api: "openai-responses" }), /"openai".*allowlist/);
});

test("an api with no known tool shape cannot search, and the reason names the api", () => {
  assert.match(refusalFor({ provider: "aqueduct", api: "anthropic-messages" }), /"anthropic-messages"/);
});

const configFile = (contents: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "liubai-config-"));
  const file = path.join(dir, "liubai.json");
  fs.writeFileSync(file, contents);
  return file;
};

const assertNamesTheFile = (error: string | undefined, file: string) =>
  assert.match(error ?? "", new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

test("a config listing providers yields them as the allowlist", () => {
  const file = configFile(JSON.stringify({ webSearch: { providers: ["aqueduct", "tuwien-geo"] } }));

  const config = loadWebSearchConfig(file);

  assert.deepEqual(config, { providers: ["aqueduct", "tuwien-geo"] });
});

test("a missing config yields an empty allowlist and reports nothing", () => {
  const missing = path.join(os.tmpdir(), "liubai-absent", "liubai.json");

  const config = loadWebSearchConfig(missing);

  assert.deepEqual(config, { providers: [] });
});

test("a config without a webSearch section yields an empty allowlist and reports nothing", () => {
  const file = configFile(JSON.stringify({ somethingElse: true }));

  const config = loadWebSearchConfig(file);

  assert.deepEqual(config, { providers: [] });
});

test("invalid JSON yields an empty allowlist and names the file", () => {
  const file = configFile("{ not json");

  const config = loadWebSearchConfig(file);

  assert.deepEqual(config.providers, []);
  assertNamesTheFile(config.error, file);
});

test("providers given as a bare string is refused rather than read as an allowlist", () => {
  const file = configFile(JSON.stringify({ webSearch: { providers: "aqueduct" } }));

  const config = loadWebSearchConfig(file);

  assert.deepEqual(config.providers, []);
  assertNamesTheFile(config.error, file);
});

test("a webSearch section that misspells providers is refused", () => {
  const file = configFile(JSON.stringify({ webSearch: { provider: ["aqueduct"] } }));

  const config = loadWebSearchConfig(file);

  assert.deepEqual(config.providers, []);
  assertNamesTheFile(config.error, file);
});

test("a config whose root is not a JSON object is refused", () => {
  const file = configFile(JSON.stringify(["aqueduct"]));

  const config = loadWebSearchConfig(file);

  assert.deepEqual(config.providers, []);
  assertNamesTheFile(config.error, file);
});

test("an explicitly empty provider list disables search without complaint", () => {
  const file = configFile(JSON.stringify({ webSearch: { providers: [] } }));

  const config = loadWebSearchConfig(file);

  assert.deepEqual(config, { providers: [] });
});

test("a provider name that is blank is refused as a malformed allowlist", () => {
  const file = configFile(JSON.stringify({ webSearch: { providers: ["aqueduct", "  "] } }));

  const config = loadWebSearchConfig(file);

  assert.deepEqual(config.providers, []);
  assertNamesTheFile(config.error, file);
});
