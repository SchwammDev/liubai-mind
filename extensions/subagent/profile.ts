import * as fs from "node:fs";
import * as path from "node:path";

import {
  loadProfilesRaw,
  extractProfiles,
  validateProfile,
  loadActiveProfileName,
  defaultActiveProfilePath,
  defaultComplexityConfigPath,
  firstProfileName,
  type ComplexityMap,
} from "./child.ts";
import { tableProblems, type ModelCatalog } from "./tier-model.ts";

export interface ProfileDeps {
  loadProfilesRaw?: (path?: string) => unknown;
  loadActiveProfileName?: (path?: string) => string | undefined;
  writeActiveProfile?: (name: string, path?: string) => void;
  configPath?: string;
  profilePath?: string;
}

export type ProfileOutcome =
  | { kind: "info"; message: string }
  | { kind: "warning"; message: string };

const FLAT_FORM_MESSAGE =
  'Complexity config is a flat object. Expected shape: { "profiles": { "<name>": { trivial, easy, medium, hard } } }.';

export function writeActiveProfile(name: string, profilePath: string = defaultActiveProfilePath()): void {
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify({ profile: name }));
}

export function availableProfileNames(configPath?: string): string[] {
  let parsed: unknown;
  try {
    parsed = loadProfilesRaw(configPath);
  } catch {
    return [];
  }
  const profiles = extractProfiles(parsed);
  return profiles === null ? [] : Object.keys(profiles);
}

interface ResolvedProfileDeps {
  configPath: string;
  profilePath: string;
  loadRaw: (path?: string) => unknown;
  loadActive: (path?: string) => string | undefined;
  write: (name: string, path?: string) => void;
}

function resolveProfileDeps(deps: ProfileDeps = {}): ResolvedProfileDeps {
  const d = deps ?? {};
  return {
    configPath: d.configPath ?? defaultComplexityConfigPath(),
    profilePath: d.profilePath ?? defaultActiveProfilePath(),
    loadRaw: d.loadProfilesRaw ?? loadProfilesRaw,
    loadActive: d.loadActiveProfileName ?? loadActiveProfileName,
    write: d.writeActiveProfile ?? writeActiveProfile,
  };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeActiveProfile(
  loadActive: (path?: string) => string | undefined,
  profilePath: string,
  profiles: Record<string, unknown>,
  names: string[],
): ProfileOutcome {
  let active: string | undefined;
  try {
    active = loadActive(profilePath);
  } catch (e) {
    return { kind: "warning", message: messageOf(e) };
  }
  active = active ?? firstProfileName(profiles);
  return { kind: "info", message: `Active profile: ${active}. Available: ${names.join(", ")}.` };
}

export function runProfileCommand(args: string, catalog: ModelCatalog, deps?: ProfileDeps): ProfileOutcome {
  const { configPath, profilePath, loadRaw, loadActive, write } = resolveProfileDeps(deps);

  let parsed: unknown;
  try {
    parsed = loadRaw(configPath);
  } catch (e) {
    return { kind: "warning", message: messageOf(e) };
  }

  const profiles = extractProfiles(parsed);
  if (profiles === null) {
    return { kind: "warning", message: FLAT_FORM_MESSAGE };
  }

  const names = Object.keys(profiles);
  if (names.length === 0) {
    return { kind: "warning", message: "No profiles defined in complexity.json." };
  }

  const trimmed = args.trim();

  if (trimmed === "") {
    return describeActiveProfile(loadActive, profilePath, profiles, names);
  }

  if (!(trimmed in profiles)) {
    return { kind: "warning", message: `Unknown profile "${trimmed}". Available: ${names.join(", ")}.` };
  }

  const structural = validateProfile(trimmed, profiles[trimmed]);
  if (structural) {
    return { kind: "warning", message: structural };
  }

  const tierProblem = tableProblems(profiles[trimmed] as ComplexityMap, catalog);
  if (tierProblem) {
    return { kind: "warning", message: tierProblem };
  }

  write(trimmed, profilePath);
  return { kind: "info", message: `Active profile: ${trimmed}.` };
}
