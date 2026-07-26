// pi resolves a bare model id by taking the first provider that lists it, with
// no warning, so a second provider silently moves every spawn to a different
// gateway — different billing, different limits, different web-search gate.
// A tier therefore names `provider/modelId` and must resolve against the live
// catalog: real model ids contain slashes, so only a lookup can tell a prefix
// from an id, and only the first slash separates the two.

import { COMPLEXITY_LEVELS, type Complexity, type ComplexityMap } from "./child.ts";
import { searchAvailability } from "../rails/web-search.ts";

const ID_LIST_CAP = 8;

export type CatalogModel = { provider: string; id: string; api: string };

export interface ModelCatalog {
  find(provider: string, modelId: string): CatalogModel | undefined;
  getAll(): CatalogModel[];
  hasConfiguredAuth(model: CatalogModel): boolean;
}

export type TierResolution =
  | { kind: "resolved"; tier: Complexity; reference: string; model: CatalogModel }
  | { kind: "error"; tier: Complexity; reference: string; message: string };

export function resolveTier(tier: Complexity, reference: string, catalog: ModelCatalog): TierResolution {
  const trimmed = reference.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return rejected(tier, trimmed, missingPrefixComplaint(trimmed, catalog));
  }

  const provider = trimmed.slice(0, slash);
  const modelId = trimmed.slice(slash + 1);
  const model = catalog.find(provider, modelId);

  return model
    ? { kind: "resolved", tier, reference: trimmed, model }
    : rejected(tier, trimmed, unresolvedComplaint(provider, modelId, trimmed, catalog));
}

export function resolveTiers(map: ComplexityMap, catalog: ModelCatalog): TierResolution[] {
  return COMPLEXITY_LEVELS.map((tier) => resolveTier(tier, map[tier], catalog));
}

// Checked once at launch so a table left with bare ids is corrected before a
// task depends on it. An empty catalog means it has not loaded yet, not that
// every tier is broken.
export function tableProblems(map: ComplexityMap, catalog: ModelCatalog): string | undefined {
  if (catalog.getAll().length === 0) return undefined;

  const problems = resolveTiers(map, catalog).filter((resolution) => resolution.kind === "error");
  return problems.length === 0 ? undefined : problems.map((problem) => problem.message).join("\n");
}

export type TierChoice = { reference: string; notes: string[] };
export type TaskAssignment = { task: string; choice: TierChoice };

export type Chosen<T> = { kind: "ok"; value: T } | { kind: "error"; message: string };

export function chooseTier(
  tier: Complexity,
  map: ComplexityMap,
  catalog: ModelCatalog,
  searchProviders: readonly string[],
): Chosen<TierChoice> {
  const resolution = resolveTier(tier, map[tier], catalog);
  if (resolution.kind === "error") return { kind: "error", message: resolution.message };

  const notes = capabilityNotes(resolution.model, catalog, searchProviders);
  return { kind: "ok", value: { reference: resolution.reference, notes } };
}

export function assignTasks(
  tasks: readonly { task: string; complexity: Complexity }[],
  map: ComplexityMap,
  catalog: ModelCatalog,
  searchProviders: readonly string[],
): Chosen<TaskAssignment[]> {
  const assignments: TaskAssignment[] = [];
  const problems = new Set<string>();

  for (const { task, complexity } of tasks) {
    const chosen = chooseTier(complexity, map, catalog, searchProviders);
    if (chosen.kind === "error") problems.add(chosen.message);
    else assignments.push({ task, choice: chosen.value });
  }

  return problems.size > 0 ? { kind: "error", message: [...problems].join("\n") } : { kind: "ok", value: assignments };
}

function capabilityNotes(model: CatalogModel, catalog: ModelCatalog, searchProviders: readonly string[]): string[] {
  const notes: string[] = [];

  const search = searchAvailability(model, searchProviders);
  if (!search.ok) notes.push(`no web search — ${search.reason}`);
  if (!catalog.hasConfiguredAuth(model)) notes.push(`no configured credentials for provider "${model.provider}"`);

  return notes;
}

function rejected(tier: Complexity, reference: string, complaint: string): TierResolution {
  return { kind: "error", tier, reference, message: `Complexity tier "${tier}" names "${reference}". ${complaint}` };
}

function missingPrefixComplaint(reference: string, catalog: ModelCatalog): string {
  const preamble =
    "A model id needs its provider prefix, because a bare id resolves to whichever provider lists it first, silently.";
  return `${preamble} ${prefixFix(reference, providersListing(reference, catalog))}`;
}

function prefixFix(reference: string, providers: string[]): string {
  if (providers.length === 0) return `No provider lists "${reference}".`;
  if (providers.length === 1) return `Use "${providers[0]}/${reference}".`;
  return `It is listed by ${providers.join(", ")} — pick one.`;
}

function unresolvedComplaint(
  provider: string,
  modelId: string,
  reference: string,
  catalog: ModelCatalog,
): string {
  const ids = idsOfProvider(provider, catalog);
  if (ids.length === 0) return `No provider is named "${provider}".${doubledPrefixHint(reference, catalog)}`;

  const complaint = `Provider "${provider}" lists no model id "${modelId}" — ids match exactly, case included.`;
  return `${complaint} It lists ${capped(ids)}.${doubledPrefixHint(reference, catalog)}`;
}

function doubledPrefixHint(reference: string, catalog: ModelCatalog): string {
  const providers = providersListing(reference, catalog);
  return providers.length === 1 ? ` Did you mean "${providers[0]}/${reference}"?` : "";
}

function providersListing(modelId: string, catalog: ModelCatalog): string[] {
  return catalog
    .getAll()
    .filter((model) => model.id === modelId)
    .map((model) => model.provider);
}

function idsOfProvider(provider: string, catalog: ModelCatalog): string[] {
  return catalog
    .getAll()
    .filter((model) => model.provider === provider)
    .map((model) => model.id);
}

function capped(ids: string[]): string {
  const hidden = ids.length - ID_LIST_CAP;
  const shown = ids.slice(0, ID_LIST_CAP).join(", ");
  return hidden > 0 ? `${shown} (+${hidden} more)` : shown;
}
