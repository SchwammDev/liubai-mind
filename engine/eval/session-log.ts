import { RULE } from "../contract.ts";
import type { RuleName } from "../contract.ts";

const RULE_NAMES: readonly RuleName[] = Object.values(RULE);
const FILE_MUTATING_TOOLS = new Set(["edit", "write"]);

interface TurnEvent {
  turn: number;
  event: Record<string, unknown>;
}

function nonEmptyLines(log: string): string[] {
  return log.split("\n").filter((line) => line.trim().length > 0);
}

function parsedEvent(line: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
}

function eventsOf(log: string): Record<string, unknown>[] {
  return nonEmptyLines(log)
    .map(parsedEvent)
    .filter((event): event is Record<string, unknown> => event !== undefined);
}

function eventsWithTurnNumber(log: string): TurnEvent[] {
  let turn = 0;
  const withTurn: TurnEvent[] = [];
  for (const event of eventsOf(log)) {
    if (event.type === "turn_start") turn += 1;
    withTurn.push({ turn, event });
  }
  return withTurn;
}

function textPartOf(part: unknown): string | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  const { type, text } = part as Record<string, unknown>;
  return type === "text" && typeof text === "string" ? text : undefined;
}

function toolResultTexts(event: Record<string, unknown>): string[] {
  if (event.type !== "tool_execution_end") return [];
  const result = event.result;
  if (typeof result !== "object" || result === null) return [];
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.map(textPartOf).filter((text): text is string => text !== undefined);
}

function ruleMarkerOccurrences(text: string, marker: string): number {
  let occurrences = 0;
  let index = text.indexOf(marker);
  while (index !== -1) {
    occurrences += 1;
    index = text.indexOf(marker, index + marker.length);
  }
  return occurrences;
}

function emptyFirings(): Record<RuleName, { count: number; turns: number[] }> {
  const entries: [RuleName, { count: number; turns: number[] }][] = RULE_NAMES.map((rule) => [rule, { count: 0, turns: [] }]);
  return Object.fromEntries(entries) as Record<RuleName, { count: number; turns: number[] }>;
}

export function nudgeFiringsIn(log: string): Record<RuleName, { count: number; turns: number[] }> {
  const firings = emptyFirings();

  for (const { turn, event } of eventsWithTurnNumber(log)) {
    for (const text of toolResultTexts(event)) {
      for (const rule of RULE_NAMES) {
        const occurrences = ruleMarkerOccurrences(text, `[${rule}]`);
        for (let i = 0; i < occurrences; i += 1) {
          firings[rule].count += 1;
          firings[rule].turns.push(turn);
        }
      }
    }
  }

  return firings;
}

export function toolCallCountsIn(log: string): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const event of eventsOf(log)) {
    if (event.type !== "tool_execution_start") continue;
    const toolName = event.toolName;
    if (typeof toolName !== "string") continue;
    counts[toolName] = (counts[toolName] ?? 0) + 1;
  }

  return counts;
}

export function firstEditTurnIn(log: string): number | null {
  for (const { turn, event } of eventsWithTurnNumber(log)) {
    if (event.type !== "tool_execution_start") continue;
    const toolName = event.toolName;
    if (typeof toolName === "string" && FILE_MUTATING_TOOLS.has(toolName)) return turn;
  }

  return null;
}

function assistantMessageStopReasons(log: string): (string | undefined)[] {
  const stopReasons: (string | undefined)[] = [];

  for (const event of eventsOf(log)) {
    if (event.type !== "message_end") continue;
    const message = event.message;
    if (typeof message !== "object" || message === null) continue;
    const { role, stopReason } = message as Record<string, unknown>;
    if (role !== "assistant") continue;
    stopReasons.push(typeof stopReason === "string" ? stopReason : undefined);
  }

  return stopReasons;
}

export function retryCountIn(log: string): number {
  const stopReasons = assistantMessageStopReasons(log);
  let retries = 0;

  for (let i = 0; i < stopReasons.length - 1; i += 1) {
    if (stopReasons[i] === "error") retries += 1;
  }

  return retries;
}

function contentPartsAreThinking(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "thinking");
}

export function reasoningIsPresentIn(log: string): boolean {
  for (const event of eventsOf(log)) {
    if (event.type !== "message_end") continue;
    const message = event.message;
    if (typeof message !== "object" || message === null) continue;
    const { role, content } = message as Record<string, unknown>;
    if (role !== "assistant") continue;
    if (contentPartsAreThinking(content)) return true;
  }

  return false;
}
