#!/usr/bin/env node
// Idempotent merge of managed Claude Code hooks into a settings.json. Strips
// any prior managed entries, then re-adds the current manifest — so running
// twice yields the same file and stale managed commands fall out cleanly.
// User hooks are preserved.
//
// A hook is "managed" when its command's leading token (the binary) matches a
// leading token of some manifest command. This is broader than exact-command
// matching on purpose: an old liubai command that's since been removed from the
// manifest still reads as managed (same binary) and gets stripped, so stale
// entries don't accumulate. A user hook calling a different binary is left alone.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const targetPath = process.argv[2] ?? join(process.env.HOME ?? "", ".claude", "settings.json");
const manifestPath = process.argv[3] ?? join(here, "..", "config", "claude-managed-hooks.json");

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readSettings(path) {
  try {
    return readJson(path);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    process.stderr.write(`sync-claude-settings: refusing to clobber malformed ${path}: ${err.message}\n`);
    process.exit(1);
  }
}

const manifest = readJson(manifestPath);

const managedBinaries = new Set(
  Object.values(manifest)
    .flat()
    .flatMap((block) => block.commands.map((cmd) => cmd.split(/\s+/)[0])),
);

function isManaged(command) {
  return managedBinaries.has(command.split(/\s+/)[0]);
}

const settings = readSettings(targetPath);
const { hooks: existingHooks, ...rest } = isObject(settings) ? settings : {};

const stripped = {};
if (isObject(existingHooks)) {
  for (const [event, blocks] of Object.entries(existingHooks)) {
    if (!Array.isArray(blocks)) continue;
    const kept = blocks
      .filter(isObject)
      .map((block) => ({
        matcher: block.matcher,
        hooks: (Array.isArray(block.hooks) ? block.hooks.filter(isObject) : []).filter(
          (h) => !isManaged(h.command),
        ),
      }))
      .filter((block) => block.hooks.length > 0);
    if (kept.length > 0) stripped[event] = kept;
  }
}

for (const [event, blocks] of Object.entries(manifest)) {
  for (const block of blocks) {
    const list = stripped[event] ?? (stripped[event] = []);
    let target = list.find((b) => b.matcher === block.matcher);
    if (!target) {
      target = { matcher: block.matcher, hooks: [] };
      list.push(target);
    }
    for (const command of block.commands) {
      target.hooks.push({ type: "command", command });
    }
  }
}

const merged = { ...rest };
if (Object.keys(stripped).length > 0) merged.hooks = stripped;

mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n");
