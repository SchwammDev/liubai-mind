import type { RuleName } from "../contract.ts";
import type { GamedReason, RawRow } from "./eval-contract.ts";
import { firstEditTurnIn, nudgeFiringsIn, reasoningIsPresentIn, retryCountIn, toolCallCountsIn } from "./session-log.ts";

export type StartsFrom = { kind: "original-source" } | { kind: "earlier-result"; sourceRun: string; sourceRepetition: number };

export type Ending = "timed-out" | "errored" | "no-edit" | "final-text";

type NudgeFirings = Record<RuleName, { count: number; turns: number[] }>;

export interface RepetitionRecord {
  caseId: string;
  treatmentId: string;
  repetition: number;
  startsFrom: StartsFrom;
  transcriptPath: string | null;
  verdict: string;
  gamedReason: GamedReason | null;
  failedBehaviorChecks: { index: number; reason: string }[];
  decisionPointsBefore: number;
  decisionPointsAfter: number;
  entrySymbolComplexityBefore: number | null;
  entrySymbolComplexityAfter: number | null;
  functionsBefore: number;
  functionsAfter: number;
  linesAdded: number;
  linesRemoved: number;
  turns: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  ending: Ending;
  retries: number | null;
  nudges: NudgeFirings | null;
  toolCalls: Record<string, number> | null;
  firstEditTurn: number | null;
  filesCreated: string[];
  reasoning: { requested: string | null; present: boolean };
  contaminated: boolean;
  consultedRail: boolean;
}

export interface RepetitionRecordInput {
  row: RawRow;
  startsFrom: StartsFrom;
  transcriptPath: string | null;
  sessionLog: string | undefined;
  verdict: string;
  gamedReason: GamedReason | null;
  failedBehaviorChecks: { index: number; reason: string }[];
  decisionPointsBefore: number;
  decisionPointsAfter: number;
  entrySymbolComplexityBefore: number | null;
  entrySymbolComplexityAfter: number | null;
  functionsBefore: number;
  functionsAfter: number;
  linesAdded: number;
  linesRemoved: number;
  entryUnchanged: boolean;
  filesCreated: string[];
  contaminated: boolean;
  consultedRail: boolean;
}

function endingFor(row: RawRow, entryUnchanged: boolean): Ending {
  if (row.timedOut === true) return "timed-out";
  if (row.agentError !== undefined) return "errored";
  if (entryUnchanged) return "no-edit";
  return "final-text";
}

function reasoningFor(row: RawRow, sessionLog: string | undefined): { requested: string | null; present: boolean } {
  return {
    requested: row.provenance.reasoning ?? null,
    present: sessionLog === undefined ? false : reasoningIsPresentIn(sessionLog),
  };
}

interface LogFacts {
  retries: number | null;
  nudges: NudgeFirings | null;
  toolCalls: Record<string, number> | null;
  firstEditTurn: number | null;
}

function logFactsFor(sessionLog: string | undefined): LogFacts {
  if (sessionLog === undefined) return { retries: null, nudges: null, toolCalls: null, firstEditTurn: null };
  return {
    retries: retryCountIn(sessionLog),
    nudges: nudgeFiringsIn(sessionLog),
    toolCalls: toolCallCountsIn(sessionLog),
    firstEditTurn: firstEditTurnIn(sessionLog),
  };
}

export function buildRepetitionRecord(input: RepetitionRecordInput): RepetitionRecord {
  const { row } = input;

  return {
    caseId: row.caseId,
    treatmentId: row.treatmentId,
    repetition: row.repetition,
    startsFrom: input.startsFrom,
    transcriptPath: input.transcriptPath,
    verdict: input.verdict,
    gamedReason: input.gamedReason,
    failedBehaviorChecks: input.failedBehaviorChecks,
    decisionPointsBefore: input.decisionPointsBefore,
    decisionPointsAfter: input.decisionPointsAfter,
    entrySymbolComplexityBefore: input.entrySymbolComplexityBefore,
    entrySymbolComplexityAfter: input.entrySymbolComplexityAfter,
    functionsBefore: input.functionsBefore,
    functionsAfter: input.functionsAfter,
    linesAdded: input.linesAdded,
    linesRemoved: input.linesRemoved,
    turns: row.turns ?? null,
    tokensIn: row.tokensIn ?? null,
    tokensOut: row.tokensOut ?? null,
    durationMs: row.durationMs,
    ending: endingFor(row, input.entryUnchanged),
    ...logFactsFor(input.sessionLog),
    filesCreated: input.filesCreated,
    reasoning: reasoningFor(row, input.sessionLog),
    contaminated: input.contaminated,
    consultedRail: input.consultedRail,
  };
}
