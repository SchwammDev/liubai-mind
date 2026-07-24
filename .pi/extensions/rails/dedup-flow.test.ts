import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RULES = {
  deny: [],
  ask: ["\\bgh\\s+issue\\s+close\\b"],
  allow: [],
  dedup: [
    "\\bgh\\s+(issue|pr)\\s+comment\\b",
    "\\bgh\\s+(issue|pr)\\s+(close|reopen)\\b",
    "\\bnpm\\s+publish\\b",
  ],
};

const rulesPath = join(mkdtempSync(join(tmpdir(), "liubai-dedup-")), "rules.json");
writeFileSync(rulesPath, JSON.stringify(RULES));
process.env.LIUBAI_RAILS_RULES = rulesPath;
process.env.LIUBAI_DEDUP_ENFORCE = "1";

const { register } = await import("./index.ts");

function fakePi() {
  const handlers = new Map<string, Array<(event: any, ctx?: any) => any>>();
  const tools = new Map<string, any>();
  const pi = {
    on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  };
  return { pi: pi as any, handlers, tools };
}

function harness() {
  const { pi, handlers, tools } = fakePi();
  const world = { state: "OPEN" };
  const calls: string[] = [];
  const confirms: string[] = [];
  const logs: any[] = [];
  const bashTool = {
    name: "bash",
    execute: async (_id: string, params: any) => {
      calls.push(params.command);
      if (/\bclose\b/.test(params.command)) world.state = "CLOSED";
      if (/\breopen\b/.test(params.command)) world.state = "OPEN";
      return { content: [{ type: "text", text: `ran#${calls.length}` }], details: undefined };
    },
  };
  const editTool = { name: "edit", execute: async () => ({ content: [], details: undefined }) };
  const exec = async (argv: string[]) => {
    if (argv.includes("state")) return { stdout: JSON.stringify({ state: world.state }), exitCode: 0 };
    if (argv.includes("comments")) return { stdout: JSON.stringify({ comments: [] }), exitCode: 0 };
    return { stdout: "", exitCode: 1 };
  };
  register(pi, { bashTool, editTool, exec, logDedup: (entry: any) => logs.push(entry) });

  const confirmingCtx = (answer: boolean) => ({
    hasUI: true,
    ui: { confirm: async (_title: string, body: string) => (confirms.push(body), answer) },
  });
  const headlessCtx = { hasUI: false };
  let callSeq = 0;
  const fire = async (event: any, ctx: any) => {
    for (const handler of handlers.get("tool_call") ?? []) {
      const outcome = await handler(event, ctx);
      if (outcome) return outcome;
    }
    return undefined;
  };
  const hook = (command: string, ctx: any) => fire({ toolName: "bash", input: { command } }, ctx);
  const run = (command: string, id?: string) =>
    tools.get("bash").execute(id ?? `call-${++callSeq}`, { command }, undefined, undefined, undefined);
  return { fire, hook, run, calls, confirms, logs, world, confirmingCtx, headlessCtx, bash: tools.get("bash") };
}

async function runUntilFirstReplay(h: ReturnType<typeof harness>) {
  await h.hook("npm publish", h.headlessCtx);
  await h.run("npm publish");
  await h.hook("npm publish", h.headlessCtx);
  await h.run("npm publish");
}

test("a re-issue after a no-op notice escalates to a confirm and a decline blocks", async () => {
  const h = harness();
  await runUntilFirstReplay(h);

  const verdict = await h.hook("npm publish", h.confirmingCtx(false));

  assert.equal(verdict?.block, true);
  assert.match(verdict?.reason ?? "", /\[dedup\]/);
  assert.equal(h.confirms.length, 1);
});

test("a re-issue after a no-op notice with no UI is blocked", async () => {
  const h = harness();
  await runUntilFirstReplay(h);

  const verdict = await h.hook("npm publish", h.headlessCtx);

  assert.equal(verdict?.block, true);
  assert.ok(h.logs.some((entry) => entry.kind === "escalate-block"));
});

test("a confirmed re-issue executes fresh instead of replaying", async () => {
  const h = harness();
  await runUntilFirstReplay(h);

  const verdict = await h.hook("npm publish", h.confirmingCtx(true));
  await h.run("npm publish");

  assert.equal(verdict, undefined);
  assert.equal(h.calls.length, 2);
});

test("a duplicate of an ask-gated command is re-confirmed and still no-ops", async () => {
  const h = harness();

  await h.hook("gh issue close 5", h.confirmingCtx(true));
  await h.run("gh issue close 5");
  await h.hook("gh issue close 5", h.confirmingCtx(true));
  const second = await h.run("gh issue close 5");

  assert.equal(h.confirms.length, 2);
  assert.equal(h.calls.length, 1);
  assert.match(second.content[0].text, /already closed/);
});

test("an ask-gated command whose effect was undone externally is confirmed again before running", async () => {
  const h = harness();

  await h.hook("gh issue close 5", h.confirmingCtx(true));
  await h.run("gh issue close 5");
  h.world.state = "OPEN";
  await h.hook("gh issue close 5", h.confirmingCtx(true));
  await h.run("gh issue close 5");

  assert.equal(h.confirms.length, 2);
  assert.equal(h.calls.length, 2);
});

test("a duplicated tool call id executes the command once and both copies see one result", async () => {
  const h = harness();

  const [first, second] = await Promise.all([
    h.run("npm publish", "dup-id"),
    h.run("npm publish", "dup-id"),
  ]);

  assert.equal(h.calls.length, 1);
  assert.equal(first, second);
  assert.ok(h.logs.some((entry) => entry.kind === "duplicate-id"));
});

test("the duplicate-id shield stays active under LIUBAI_RAILS_OFF", async () => {
  process.env.LIUBAI_RAILS_OFF = "1";
  try {
    const h = harness();

    await Promise.all([h.run("seq 5", "dup-id"), h.run("seq 5", "dup-id")]);

    assert.equal(h.calls.length, 1);
  } finally {
    delete process.env.LIUBAI_RAILS_OFF;
  }
});

test("a duplicated call id for a tool the shield cannot wrap is blocked on second delivery", async () => {
  const h = harness();

  const first = await h.fire({ toolName: "spawn", toolCallId: "sp-1", input: {} }, h.headlessCtx);
  const second = await h.fire({ toolName: "spawn", toolCallId: "sp-1", input: {} }, h.headlessCtx);

  assert.equal(first, undefined);
  assert.equal(second?.block, true);
  assert.ok(h.logs.some((entry) => entry.kind === "duplicate-id" && entry.action === "blocked"));
});

test("the duplicate-id block for unwrapped tools stays active under LIUBAI_RAILS_OFF", async () => {
  process.env.LIUBAI_RAILS_OFF = "1";
  try {
    const h = harness();

    await h.fire({ toolName: "spawn", toolCallId: "sp-2", input: {} }, h.headlessCtx);
    const second = await h.fire({ toolName: "spawn", toolCallId: "sp-2", input: {} }, h.headlessCtx);

    assert.equal(second?.block, true);
  } finally {
    delete process.env.LIUBAI_RAILS_OFF;
  }
});

test("LIUBAI_RAILS_OFF delegates the overridden bash tool byte-identically", async () => {
  process.env.LIUBAI_RAILS_OFF = "1";
  try {
    const h = harness();
    const first = await h.run("npm publish");
    const second = await h.run("npm publish");

    assert.equal(h.calls.length, 2);
    assert.equal(first.content[0].text, "ran#1");
    assert.equal(second.content[0].text, "ran#2");
    assert.equal(h.logs.length, 0);
  } finally {
    delete process.env.LIUBAI_RAILS_OFF;
  }
});
