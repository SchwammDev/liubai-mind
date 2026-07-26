// The TU Wien aqueduct gateway executes a `web_search` tool server-side on its
// OpenAI Responses API — no client tool-calling involved, so this works even on
// models whose structured tool calls are unreliable. Scoped to aqueduct because
// on paid providers (OpenAI) the same tool type would silently incur cost.

export type ModelTarget = { provider: string; api: string };
export type ResponsesPayload = { tools?: Array<{ type: string }> } & Record<string, unknown>;

const PROVIDER = "aqueduct";
const API = "openai-responses";
const WEB_SEARCH = { type: "web_search" };

export function injectWebSearch(
  payload: unknown,
  model: ModelTarget | undefined,
): ResponsesPayload | undefined {
  if (model?.provider !== PROVIDER || model.api !== API) return undefined;
  if (!isResponsesPayload(payload)) return undefined;

  const tools = payload.tools ?? [];
  if (tools.some((tool) => tool.type === WEB_SEARCH.type)) return undefined;

  return { ...payload, tools: [...tools, WEB_SEARCH] };
}

function isResponsesPayload(payload: unknown): payload is ResponsesPayload {
  if (typeof payload !== "object" || payload === null) return false;
  if (!("tools" in payload) || payload.tools === undefined) return true;
  return Array.isArray(payload.tools) && payload.tools.every(hasToolType);
}

function hasToolType(tool: unknown): tool is { type: string } {
  return typeof tool === "object" && tool !== null && "type" in tool && typeof tool.type === "string";
}
