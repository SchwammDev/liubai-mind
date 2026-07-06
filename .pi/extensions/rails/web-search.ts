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
  payload: ResponsesPayload,
  model: ModelTarget | undefined,
): ResponsesPayload | undefined {
  if (model?.provider !== PROVIDER || model.api !== API) return undefined;

  const tools = payload.tools ?? [];
  if (tools.some((tool) => tool.type === WEB_SEARCH.type)) return undefined;

  return { ...payload, tools: [...tools, WEB_SEARCH] };
}
