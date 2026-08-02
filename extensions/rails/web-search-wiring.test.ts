import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "liubai-home-"));
const configPath = join(home, ".pi/agent/liubai.json");
mkdirSync(join(home, ".pi/agent"), { recursive: true });
process.env.HOME = home;

const { register } = await import("./index.ts");

function fakePi() {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const pi = { on: (name: string, fn: any) => handlers.set(name, fn), registerTool: () => {} };
  return { pi: pi as any, handlers };
}

function railsWithConfig(config: unknown) {
  writeFileSync(configPath, JSON.stringify(config));
  const { pi, handlers } = fakePi();
  const notices: string[] = [];
  register(pi, { logDedup: () => {} });
  const request = (ctx: any, payload: unknown = { tools: [] }) =>
    handlers.get("before_provider_request")?.({ payload }, ctx);
  const uiCtx = (extra: Record<string, unknown> = {}) => ({
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    ...extra,
  });
  return { request, notices, uiCtx };
}

const MALFORMED = { webSearch: {} };
const ALLOWING = { webSearch: { providers: ["openai"] } };
const OPENAI_MODEL = { provider: "openai", api: "openai-responses" };

test("a malformed web-search config is reported to the operator once", async () => {
  const rails = railsWithConfig(MALFORMED);

  await rails.request(rails.uiCtx());
  await rails.request(rails.uiCtx());
  await rails.request({ hasUI: false });

  assert.deepEqual(rails.notices.length, 1);
  assert.match(rails.notices[0] ?? "", /web-search/);
});

test("a valid config injects the server-side search tool into the request", async () => {
  const rails = railsWithConfig(ALLOWING);

  const out = await rails.request(rails.uiCtx({ model: OPENAI_MODEL }));

  assert.ok(out?.tools?.some((tool: any) => tool.type === "web_search"));
  assert.deepEqual(rails.notices, []);
});
