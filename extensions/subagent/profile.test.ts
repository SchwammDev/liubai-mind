import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { availableProfileNames, runProfileCommand, type ProfileDeps } from "./profile.ts";
import type { CatalogModel, ModelCatalog } from "./tier-model.ts";

const entry = (provider: string, id: string): CatalogModel => ({ provider, id, api: "openai-responses" });

const CATALOG_ENTRIES = [
  entry("gw", "tiny"),
  entry("gw", "small"),
  entry("gw", "mid"),
  entry("gw", "big"),
];

const catalog: ModelCatalog = {
  find: (provider, modelId) => CATALOG_ENTRIES.find((m) => m.provider === provider && m.id === modelId),
  getAll: () => [...CATALOG_ENTRIES],
  hasConfiguredAuth: () => true,
};

const GOOD_MAP = { trivial: "gw/tiny", easy: "gw/small", medium: "gw/mid", hard: "gw/big" };
const PROFILES = { default: GOOD_MAP, heavy: { ...GOOD_MAP, hard: "gw/big" } };

const setup = (config: string, active?: string): { configPath: string; profilePath: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
  const configPath = path.join(dir, "complexity.json");
  const profilePath = path.join(dir, "active-profile.json");
  fs.writeFileSync(configPath, config);
  if (active !== undefined) fs.writeFileSync(profilePath, JSON.stringify({ profile: active }));
  return { configPath, profilePath };
};

const depsWith = (configPath: string, profilePath: string, extra: Partial<ProfileDeps> = {}): ProfileDeps => ({
  configPath,
  profilePath,
  ...extra,
});

test("no arg names the active profile and lists the available ones", () => {
  const { configPath, profilePath } = setup(JSON.stringify({ profiles: PROFILES }), "heavy");
  const deps = depsWith(configPath, profilePath);

  const outcome = runProfileCommand("", catalog, deps);

  assert.equal(outcome.kind, "info");
  assert.match(outcome.message, /Active profile: heavy/);
  assert.match(outcome.message, /Available: .*default.*heavy/);
});

test("no arg with no active-profile.json names the first profile as the fallback", () => {
  const { configPath, profilePath } = setup(JSON.stringify({ profiles: PROFILES }));
  const deps = depsWith(configPath, profilePath);

  const outcome = runProfileCommand("   ", catalog, deps);

  assert.equal(outcome.kind, "info");
  assert.match(outcome.message, /Active profile: default/);
});

test("an unknown name is refused with the available profiles listed", () => {
  const { configPath, profilePath } = setup(JSON.stringify({ profiles: PROFILES }));
  const deps = depsWith(configPath, profilePath);

  const outcome = runProfileCommand("ghost", catalog, deps);

  assert.equal(outcome.kind, "warning");
  assert.match(outcome.message, /ghost/);
  assert.match(outcome.message, /Available: .*default.*heavy/);
});

test("a structurally broken profile is refused and nothing is written", () => {
  const broken = { trivial: "gw/tiny", easy: "gw/small", medium: "gw/mid" };
  const { configPath, profilePath } = setup(JSON.stringify({ profiles: { broken } }));
  let written: string | undefined;
  const deps = depsWith(configPath, profilePath, {
    writeActiveProfile: (name) => {
      written = name;
    },
  });

  const outcome = runProfileCommand("broken", catalog, deps);

  assert.equal(outcome.kind, "warning");
  assert.match(outcome.message, /broken/);
  assert.match(outcome.message, /hard/);
  assert.equal(written, undefined);
});

test("a tier that does not resolve is refused naming the tier and nothing is written", () => {
  const bareId = { ...GOOD_MAP, hard: "big" };
  const { configPath, profilePath } = setup(JSON.stringify({ profiles: { bareId } }));
  let written: string | undefined;
  const deps = depsWith(configPath, profilePath, {
    writeActiveProfile: (name) => {
      written = name;
    },
  });

  const outcome = runProfileCommand("bareId", catalog, deps);

  assert.equal(outcome.kind, "warning");
  assert.match(outcome.message, /hard/);
  assert.equal(written, undefined);
});

test("a profile whose tiers all resolve is written and confirmed", () => {
  const { configPath, profilePath } = setup(JSON.stringify({ profiles: PROFILES }));

  const outcome = runProfileCommand("heavy", catalog, depsWith(configPath, profilePath));

  assert.equal(outcome.kind, "info");
  assert.match(outcome.message, /Active profile: heavy/);
  const written = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  assert.deepEqual(written, { profile: "heavy" });
});

test("a flat-form config is refused naming the target shape", () => {
  const { configPath, profilePath } = setup(JSON.stringify(GOOD_MAP));
  const deps = depsWith(configPath, profilePath);

  const outcome = runProfileCommand("default", catalog, deps);

  assert.equal(outcome.kind, "warning");
  assert.match(outcome.message, /profiles/);
});

test("a load error is surfaced as a warning carrying the message", () => {
  const missing = path.join(os.tmpdir(), "does-not-exist-profile", "complexity.json");
  const profilePath = path.join(os.tmpdir(), "does-not-exist-profile", "active-profile.json");
  const deps = depsWith(missing, profilePath);

  const outcome = runProfileCommand("default", catalog, deps);

  assert.equal(outcome.kind, "warning");
  assert.match(outcome.message, /not found/);
});

test("a config with no profiles is refused for any command", () => {
  const { configPath, profilePath } = setup(JSON.stringify({ profiles: {} }));
  const deps = depsWith(configPath, profilePath);

  const outcome = runProfileCommand("", catalog, deps);

  assert.equal(outcome.kind, "warning");
 assert.match(outcome.message, /no profiles/i);
});

test("a corrupt active-profile.json is surfaced as a warning, not silently fallen back from", () => {
  const { configPath, profilePath } = setup(JSON.stringify({ profiles: PROFILES }));
  fs.writeFileSync(profilePath, "{ not json");
  const deps = depsWith(configPath, profilePath);

  const outcome = runProfileCommand("", catalog, deps);

  assert.equal(outcome.kind, "warning");
  assert.match(outcome.message, /not valid JSON/);
});

test("availableProfileNames returns profile names for a nested config", () => {
  const { configPath } = setup(JSON.stringify({ profiles: PROFILES }));

  assert.deepEqual(availableProfileNames(configPath), ["default", "heavy"]);
});

test("availableProfileNames returns an empty array for a flat form", () => {
  const { configPath } = setup(JSON.stringify(GOOD_MAP));

  assert.deepEqual(availableProfileNames(configPath), []);
});

test("availableProfileNames returns an empty array for a missing file", () => {
  const missing = path.join(os.tmpdir(), "does-not-exist-profile-names", "complexity.json");

  assert.deepEqual(availableProfileNames(missing), []);
});
