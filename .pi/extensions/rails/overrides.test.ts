import { test } from "node:test";
import assert from "node:assert/strict";

import { withBashDedup, withEditDedup } from "./overrides.ts";
import { approveRerun, bashKey, createSession, REPLAY_NOTICE, type Exec } from "./dedup.ts";

const PATTERNS = [
  "\\bgh\\s+(issue|pr)\\s+comment\\b",
  "\\bgh\\s+(issue|pr)\\s+(close|reopen)\\b",
  "\\bnpm\\s+publish\\b",
];

const COMMENT_URL = "https://github.com/o/r/issues/5#issuecomment-1";

type World = { state: string; comments: Array<{ body: string; url: string }>; exec: Exec; execCalls: number };

function ghWorld(initial: Partial<World> = {}): World {
  const world: World = {
    state: initial.state ?? "OPEN",
    comments: initial.comments ?? [],
    execCalls: 0,
    exec: async (argv) => {
      world.execCalls += 1;
      const field = argv[argv.indexOf("--json") + 1];
      if (field === "comments") return { stdout: JSON.stringify({ comments: world.comments }), exitCode: 0 };
      if (field === "state") return { stdout: JSON.stringify({ state: world.state }), exitCode: 0 };
      return { stdout: "", exitCode: 1 };
    },
  };
  return world;
}

function bashHarness(opts: { world?: World; enforced?: boolean; disabled?: boolean } = {}) {
  const session = createSession();
  const logs: any[] = [];
  const calls: string[] = [];
  const world = opts.world ?? ghWorld();
  const delegate = {
    name: "bash",
    execute: async (_id: string, params: any) => {
      calls.push(params.command);
      if (/\bclose\b/.test(params.command)) world.state = "CLOSED";
      if (/\breopen\b/.test(params.command)) world.state = "OPEN";
      return { content: [{ type: "text", text: `ran#${calls.length}: ${params.command}` }], details: undefined };
    },
  };
  const tool = withBashDedup(delegate, {
    patterns: PATTERNS,
    session,
    exec: world.exec,
    log: (entry) => logs.push(entry),
    enforced: () => opts.enforced ?? true,
    disabled: () => opts.disabled ?? false,
  });
  const run = (command: string) => tool.execute("id", { command }, undefined, undefined, undefined);
  return { tool, session, logs, calls, world, run };
}

function resultText(result: any): string {
  return result.content.map((part: any) => part.text ?? "").join("");
}

test("a duplicate gh comment no-ops without executing and reports the existing URL", async () => {
  const world = ghWorld({ comments: [{ body: "Fix  confirmed, thanks!", url: COMMENT_URL }] });
  const h = bashHarness({ world });

  const result = await h.run('gh issue comment 5 --body "fix confirmed, thanks!"');

  assert.equal(h.calls.length, 0);
  assert.notEqual(result.isError, true);
  assert.match(resultText(result), new RegExp(COMMENT_URL));
});

test("close reopen close consults live state so the third close executes", async () => {
  const h = bashHarness();

  await h.run("gh issue close 5");
  await h.run("gh issue reopen 5");
  await h.run("gh issue close 5");

  assert.equal(h.calls.length, 3);
});

test("a replayed duplicate returns the original result prefixed with the dedup notice", async () => {
  const h = bashHarness();

  await h.run("npm publish");
  const replayed = await h.run("npm publish");

  assert.equal(h.calls.length, 1);
  assert.notEqual(replayed.isError, true);
  assert.match(resultText(replayed), new RegExp(`^\\[dedup\\]`));
  assert.ok(resultText(replayed).startsWith(REPLAY_NOTICE));
  assert.match(resultText(replayed), /ran#1: npm publish/);
});

test("a failed first run is not cached for replay", async () => {
  const session = createSession();
  let attempts = 0;
  const delegate = {
    name: "bash",
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network down");
      return { content: [{ type: "text", text: "published" }], details: undefined };
    },
  };
  const tool = withBashDedup(delegate, {
    patterns: PATTERNS,
    session,
    exec: async () => ({ stdout: "", exitCode: 1 }),
    log: () => {},
    enforced: () => true,
    disabled: () => false,
  });
  const run = () => tool.execute("id", { command: "npm publish" }, undefined, undefined, undefined);

  await assert.rejects(run);
  const second = await run();

  assert.equal(attempts, 2);
  assert.equal(resultText(second), "published");
});

test("an approved rerun executes fresh and refreshes the replay cache", async () => {
  const h = bashHarness();
  await h.run("npm publish");
  await h.run("npm publish");

  approveRerun(h.session, bashKey("npm publish"));
  await h.run("npm publish");
  const replayed = await h.run("npm publish");

  assert.equal(h.calls.length, 2);
  assert.match(resultText(replayed), /ran#2: npm publish/);
});

test("log-only mode logs the would-be dedup and executes anyway", async () => {
  const world = ghWorld({ comments: [{ body: "done", url: COMMENT_URL }] });
  const h = bashHarness({ world, enforced: false });

  await h.run("gh issue comment 5 --body done");

  assert.equal(h.calls.length, 1);
  assert.ok(h.logs.some((entry) => entry.kind === "would-dedup"));
});

test("an unparseable dedup-listed command logs a parse miss and executes", async () => {
  const h = bashHarness();

  await h.run("gh issue comment 5 --body-file notes.md");

  assert.equal(h.calls.length, 1);
  assert.ok(h.logs.some((entry) => entry.kind === "parse-miss"));
});

test("rails off delegates byte-identically without checks or logging", async () => {
  const sentinel = { content: [{ type: "text", text: "raw" }], details: undefined };
  const world = ghWorld();
  const session = createSession();
  const logs: any[] = [];
  const tool = withBashDedup(
    { name: "bash", execute: async () => sentinel },
    {
      patterns: PATTERNS,
      session,
      exec: world.exec,
      log: (entry) => logs.push(entry),
      enforced: () => true,
      disabled: () => true,
    },
  );

  const result = await tool.execute("id", { command: "npm publish" }, undefined, undefined, undefined);

  assert.equal(result, sentinel);
  assert.equal(world.execCalls, 0);
  assert.equal(logs.length, 0);
});

function editHarness(opts: { file?: string; readFails?: boolean; enforced?: boolean } = {}) {
  const session = createSession();
  const logs: any[] = [];
  const calls: any[] = [];
  const delegate = {
    name: "edit",
    execute: async (_id: string, params: any) => {
      calls.push(params);
      return { content: [{ type: "text", text: "edited" }], details: undefined };
    },
  };
  const tool = withEditDedup(delegate, {
    session,
    readTargetFile: async () => {
      if (opts.readFails) throw new Error("unreadable");
      return opts.file ?? "";
    },
    log: (entry) => logs.push(entry),
    enforced: () => opts.enforced ?? true,
    disabled: () => false,
  });
  const run = (path: string, edits: Array<{ oldText: string; newText: string }>) =>
    tool.execute("id", { path, edits }, undefined, undefined, undefined);
  return { logs, calls, run };
}

const DOC = ["# Setup", "", "step one", "step two", "step three"].join("\n");
const REINSERT = [{ oldText: "# Setup", newText: "# Setup\nstep one\nstep two\nstep three" }];

test("an edit re-adding content already in the file no-ops with its location", async () => {
  const h = editHarness({ file: DOC });

  const result = await h.run("notes.md", REINSERT);

  assert.equal(h.calls.length, 0);
  assert.notEqual(result.isError, true);
  assert.match(resultText(result), /already present at notes\.md:3/);
});

test("an edit inserting new content executes normally", async () => {
  const h = editHarness({ file: DOC });

  await h.run("notes.md", [{ oldText: "# Setup", newText: "# Setup\nfresh a\nfresh b\nfresh c" }]);

  assert.equal(h.calls.length, 1);
});

test("an unreadable target file skips the duplicate check and executes", async () => {
  const h = editHarness({ readFails: true });

  await h.run("notes.md", REINSERT);

  assert.equal(h.calls.length, 1);
});

test("log-only mode lets a duplicate edit through and logs it", async () => {
  const h = editHarness({ file: DOC, enforced: false });

  await h.run("notes.md", REINSERT);

  assert.equal(h.calls.length, 1);
  assert.ok(h.logs.some((entry) => entry.kind === "would-dedup"));
});
