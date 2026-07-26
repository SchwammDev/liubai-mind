// Two kinds of knowledge used to be fused here. Which gateways may run a
// server-side search is user knowledge — machine-specific, and billing-relevant
// because the tool costs per call on a paid gateway — so it lives in
// `~/.pi/agent/liubai.json` and anything ambiguous resolves to no injection.
// What the tool payload looks like is protocol knowledge keyed by API family, so
// it stays in the table below, which another api joins as an entry.
// A `spawn` child is a separate pi process loading these same rails, so it reads
// the same config and the gate applies to the child's own resolved model.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Liubai's own capability toggles, owner-namespaced because `~/.pi/agent/` is
// shared with pi's settings.json and models.json. It lives here rather than in
// the rails entry point so the spawn tool reads the same allowlist.
export const LIUBAI_CONFIG = join(homedir(), ".pi/agent/liubai.json");

export type ModelTarget = { provider: string; api: string };
export type ToolPayload = { tools?: unknown[] } & Record<string, unknown>;

export type SearchTool = {
  tool: Record<string, unknown>;
  alreadyPresent: (tools: readonly unknown[]) => boolean;
};

export const SEARCH_TOOL_BY_API: Record<string, SearchTool> = {
  "openai-responses": {
    tool: { type: "web_search" },
    alreadyPresent: (tools) => tools.some((tool) => toolType(tool) === "web_search"),
  },
};

export type SearchAvailability = { ok: true } | { ok: false; reason: string };

// The spawn tool predicts a child's search capability from this same predicate,
// so the prediction cannot drift from what the child's rails actually do.
export function searchAvailability(
  model: ModelTarget | undefined,
  allowedProviders: readonly string[],
  searchTools: Record<string, SearchTool> = SEARCH_TOOL_BY_API,
): SearchAvailability {
  if (!model) return { ok: false, reason: "no model is resolved" };
  if (!allowedProviders.includes(model.provider)) {
    return { ok: false, reason: `provider "${model.provider}" is not in the web-search allowlist` };
  }
  if (!searchTools[model.api]) {
    return { ok: false, reason: `the "${model.api}" api has no server-side search payload` };
  }
  return { ok: true };
}

export function injectWebSearch(
  payload: unknown,
  model: ModelTarget | undefined,
  allowedProviders: readonly string[],
  searchTools: Record<string, SearchTool> = SEARCH_TOOL_BY_API,
): ToolPayload | undefined {
  if (!model || !searchAvailability(model, allowedProviders, searchTools).ok) return undefined;

  const search = searchTools[model.api];
  if (!search || !isToolPayload(payload)) return undefined;

  const tools = payload.tools ?? [];
  if (search.alreadyPresent(tools)) return undefined;

  return { ...payload, tools: [...tools, search.tool] };
}

function isToolPayload(payload: unknown): payload is ToolPayload {
  if (typeof payload !== "object" || payload === null) return false;
  if (!("tools" in payload)) return true;
  return payload.tools === undefined || Array.isArray(payload.tools);
}

function toolType(tool: unknown): string | undefined {
  if (typeof tool !== "object" || tool === null || !("type" in tool)) return undefined;
  return typeof tool.type === "string" ? tool.type : undefined;
}

export type WebSearchConfig = { providers: string[]; error?: string };

export function loadWebSearchConfig(configPath: string): WebSearchConfig {
  const raw = readIfPresent(configPath);
  if (raw === undefined) return { providers: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refused(configPath, "is not valid JSON");
  }
  if (!isJsonObject(parsed)) return refused(configPath, "must hold a JSON object");
  if (!("webSearch" in parsed)) return { providers: [] };

  return allowlistOf(parsed.webSearch, configPath);
}

function allowlistOf(webSearch: unknown, configPath: string): WebSearchConfig {
  if (!isJsonObject(webSearch) || !("providers" in webSearch)) {
    return refused(configPath, "needs a webSearch.providers key");
  }
  if (!isProviderNames(webSearch.providers)) {
    return refused(configPath, "needs webSearch.providers as an array of provider names");
  }
  return { providers: [...webSearch.providers] };
}

function refused(configPath: string, complaint: string): WebSearchConfig {
  return { providers: [], error: `${configPath} ${complaint}, so web search stays off.` };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderNames(providers: unknown): providers is string[] {
  return Array.isArray(providers) && providers.every((name) => typeof name === "string" && name.trim() !== "");
}

function readIfPresent(configPath: string): string | undefined {
  try {
    return readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
}
