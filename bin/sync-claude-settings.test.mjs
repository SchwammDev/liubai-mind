import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "sync-claude-settings.mjs");

const MANIFEST = {
  PreToolUse: [
    { matcher: "Edit|Write|MultiEdit", commands: ["$HOME/.local/bin/liubai cc-hook"] },
  ],
};

function newSandbox() {
  const dir = mkdtempSync(join(tmpdir(), "cc-sync-"));
  const target = join(dir, "settings.json");
  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, JSON.stringify(MANIFEST));
  return { dir, target, manifest };
}

function run(target, manifest) {
  return spawnSync(process.execPath, [SCRIPT_PATH, target, manifest], {
    encoding: "utf8",
  });
}

function readTarget(target) {
  return JSON.parse(readFileSync(target, "utf8"));
}

test("merge adds managed entries into an empty settings file", () => {
  const { dir, target, manifest } = newSandbox();

  const res = run(target, manifest);

  assert.equal(res.status, 0, res.stderr);
  const settings = readTarget(target);
  const block = settings.hooks.PreToolUse.find((b) => b.matcher === MANIFEST.PreToolUse[0].matcher);
  assert.deepEqual(
    block.hooks,
    [{ type: "command", command: MANIFEST.PreToolUse[0].commands[0] }],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("merge preserves existing user hooks", () => {
  const { dir, target, manifest } = newSandbox();
  const userCommand = "echo user-hook";
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    JSON.stringify({
      someOtherKey: true,
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: userCommand }] }],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "echo post" }] }],
      },
    }),
  );

  const res = run(target, manifest);

  assert.equal(res.status, 0, res.stderr);
  const settings = readTarget(target);
  assert.equal(settings.someOtherKey, true);
  const preBlocks = settings.hooks.PreToolUse;
  const userBlock = preBlocks.find((b) => b.matcher === "Bash");
  assert.deepEqual(userBlock.hooks, [{ type: "command", command: userCommand }]);
  const managedBlock = preBlocks.find((b) => b.matcher === MANIFEST.PreToolUse[0].matcher);
  assert.ok(managedBlock, "managed block present");
  assert.deepEqual(
    managedBlock.hooks,
    [{ type: "command", command: MANIFEST.PreToolUse[0].commands[0] }],
  );
  const postBlock = settings.hooks.PostToolUse.find((b) => b.matcher === "*");
  assert.deepEqual(postBlock.hooks, [{ type: "command", command: "echo post" }]);
  rmSync(dir, { recursive: true, force: true });
});

test("merge is idempotent", () => {
  const { dir, target, manifest } = newSandbox();

  run(target, manifest);
  const first = readFileSync(target, "utf8");

  run(target, manifest);
  const second = readFileSync(target, "utf8");

  assert.equal(second, first);
  const settings = JSON.parse(second);
  const block = settings.hooks.PreToolUse.find((b) => b.matcher === MANIFEST.PreToolUse[0].matcher);
  assert.equal(block.hooks.length, 1, "managed hook appears once, not duplicated");
  rmSync(dir, { recursive: true, force: true });
});

test("merge strips stale managed entries", () => {
  const { dir, target, manifest } = newSandbox();
  const staleCommand = "$HOME/.local/bin/liubai old-command";
  const currentCommand = MANIFEST.PreToolUse[0].commands[0];
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: MANIFEST.PreToolUse[0].matcher,
            hooks: [{ type: "command", command: staleCommand }],
          },
        ],
      },
    }),
  );

  const res = run(target, manifest);

  assert.equal(res.status, 0, res.stderr);
  const settings = readTarget(target);
  const block = settings.hooks.PreToolUse.find((b) => b.matcher === MANIFEST.PreToolUse[0].matcher);
  const commands = block.hooks.map((h) => h.command);
  assert.ok(!commands.includes(staleCommand), "stale managed command stripped");
  assert.ok(commands.includes(currentCommand), "current manifest command present");
  rmSync(dir, { recursive: true, force: true });
});

test("malformed target settings is refused", () => {
  const { dir, target, manifest } = newSandbox();
  mkdirSync(dirname(target), { recursive: true });
  const original = "{ broken";
  writeFileSync(target, original);

  const res = run(target, manifest);

  assert.equal(res.status, 1);
  assert.notEqual(res.stderr, "");
  assert.equal(readFileSync(target, "utf8"), original, "target unchanged");
  rmSync(dir, { recursive: true, force: true });
});
