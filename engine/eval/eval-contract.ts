import type { Lang, RuleName } from "../contract.ts";

export interface ConditionManifest {
  id: string;
  env: Record<string, string>;
  phrasingPack?: string;
  expectedZeroFirings?: boolean;
  delivery?: "prompt" | "rail";
}

export type Probe = { args: unknown[]; returns: unknown } | { args: unknown[]; throws: string };

export type Tier = "easy" | "hard";

export interface ExtensionSpec {
  task: string;
  probes: Probe[];
}

export interface CaseManifest {
  id: string;
  lang: Lang;
  files: string[];
  entry: string;
  entrySymbol: string;
  task: string;
  baseline: BaselineMetrics;
  tier: Tier;
  tags?: string[];
  genuineDpMax?: number;
  probes: Probe[];
  reference?: Record<string, string>;
  extension?: ExtensionSpec;
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

export type Verdict = "genuine-fix" | "gamed" | "bar-missed" | "untouched" | "broken" | "behavior-broken" | "errored" | "timed-out";

export type GamedReason = "helper-split" | "silent-handler";

export interface JudgeResult {
  verdict: Verdict;
  gamedReason?: GamedReason;
  probesPassed?: boolean;
  createdFiles: string[];
  referencedFiles: string[];
  before: Metrics;
  after: Metrics;
}

export interface Provenance {
  conditionId: string;
  phrasingPackHash: string | null;
  liubaiSha: string;
  model: string;
  collectedAt: string;
}

export interface SecondTouchInfo {
  sourceRun: string;
  sourceRep: number | null;
  control: boolean;
}

export interface RawRow {
  caseId: string;
  conditionId: string;
  rep: number;
  provenance: Provenance;
  task?: string;
  files: Record<string, string>;
  snapshotDropped?: string[];
  exitCode: number;
  timedOut: boolean;
  signal?: string;
  stderrTail?: string;
  durationMs: number;
  turns?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheReadTokens?: number;
  railFirings?: Record<RuleName, number>;
  shadowFirings?: Record<RuleName, number>;
  delivered?: { packHash: string | null; liveRules: string[]; shadowRules: string[] };
  agentError?: string;
  secondTouch?: SecondTouchInfo;
}
