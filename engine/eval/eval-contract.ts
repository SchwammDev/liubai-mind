import type { Lang } from "../contract.ts";

export interface ConditionManifest {
  id: string;
  env: Record<string, string>;
  phrasingPack?: string;
}

export type Probe = { args: unknown[]; returns: unknown } | { args: unknown[]; throws: string };

export interface CaseManifest {
  id: string;
  lang: Lang;
  files: string[];
  entry: string;
  entrySymbol: string;
  task: string;
  baseline: BaselineMetrics;
  probes: Probe[];
}

export interface BaselineMetrics {
  decisionPoints: number;
  functions: number;
  silentHandlers: number;
}

export interface Metrics {
  decisionPoints: number;
  nFunctions: number;
  silentHandlers: number;
  parsed: boolean;
}

export type Verdict = "genuine-fix" | "gamed" | "no-reduction" | "untouched" | "broken" | "errored";

export type GamedReason = "helper-split" | "silent-handler";

export interface JudgeResult {
  verdict: Verdict;
  gamedReason?: GamedReason;
  before: Metrics;
  after: Metrics;
}

export interface Provenance {
  conditionId: string;
  phrasingPackHash: string | null;
  liubaiSha: string;
  model: string;
  collectedAt: string;
  pyCcBackend?: string;
}

export interface RawRow {
  caseId: string;
  conditionId: string;
  rep: number;
  provenance: Provenance;
  files: Record<string, string>;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  agentError?: string;
}
