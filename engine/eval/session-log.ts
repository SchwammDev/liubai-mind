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

const MAX_TOOL_TEXT_CHARS = 4000;

export interface TranscriptToolCallView {
  name: string;
  summary: string;
  summaryTruncated: boolean;
  result: string | null;
  resultTruncated: boolean;
  resultLineCount: number;
  isError: boolean;
  diff: string | null;
  diffTruncated: boolean;
}

export interface TranscriptTurnView {
  number: number;
  userText: string | null;
  assistantText: string | null;
  thinking: string | null;
  isFinal: boolean;
  isRetryFailure: boolean;
  toolCalls: string[];
  toolCallDetails: TranscriptToolCallView[];
  nudges: string[];
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface TranscriptView {
  turns: TranscriptTurnView[];
  reasoningPresent: boolean;
}

function capped(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TOOL_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TOOL_TEXT_CHARS), truncated: true };
}

function lineCountOf(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function emptyTurn(number: number): TranscriptTurnView {
  return {
    number,
    userText: null,
    assistantText: null,
    thinking: null,
    isFinal: false,
    isRetryFailure: false,
    toolCalls: [],
    toolCallDetails: [],
    nudges: [],
    tokensIn: null,
    tokensOut: null,
  };
}

function joinedTextOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content.map(textPartOf).filter((text): text is string => text !== undefined);
  return parts.length === 0 ? null : parts.join("\n");
}

function thinkingPartOf(part: unknown): string | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  const { type, thinking } = part as Record<string, unknown>;
  return type === "thinking" && typeof thinking === "string" ? thinking : undefined;
}

function thinkingTextOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts = content.map(thinkingPartOf).filter((thinking): thinking is string => thinking !== undefined);
  return parts.length === 0 ? null : parts.join("\n");
}

function usageOf(message: Record<string, unknown>): { input: number | null; output: number | null } {
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) return { input: null, output: null };
  const { input, output } = usage as Record<string, unknown>;
  return { input: typeof input === "number" ? input : null, output: typeof output === "number" ? output : null };
}

function detailsDiffOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const details = (result as Record<string, unknown>).details;
  if (typeof details !== "object" || details === null) return undefined;
  const diff = (details as Record<string, unknown>).diff;
  return typeof diff === "string" ? diff : undefined;
}

const PATH_CARRYING_TOOLS = new Set(["read", "write", "edit"]);

function argsObjectOf(event: Record<string, unknown>): Record<string, unknown> {
  const args = event.args;
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

function toolCallSummary(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash" && typeof args.command === "string") return args.command;
  if (PATH_CARRYING_TOOLS.has(toolName) && typeof args.path === "string") return args.path;
  return JSON.stringify(args);
}

function applyToolExecutionStart(
  turnView: TranscriptTurnView,
  event: Record<string, unknown>,
  pendingByCallId: Map<string, TranscriptToolCallView>,
): void {
  const toolCallId = event.toolCallId;
  const toolName = event.toolName;
  if (typeof toolCallId !== "string" || typeof toolName !== "string") return;

  const summary = capped(toolCallSummary(toolName, argsObjectOf(event)));
  const detail: TranscriptToolCallView = {
    name: toolName,
    summary: summary.text,
    summaryTruncated: summary.truncated,
    result: null,
    resultTruncated: false,
    resultLineCount: 0,
    isError: false,
    diff: null,
    diffTruncated: false,
  };

  turnView.toolCalls.push(toolName);
  turnView.toolCallDetails.push(detail);
  pendingByCallId.set(toolCallId, detail);
}

function applyToolExecutionEnd(
  event: Record<string, unknown>,
  pendingByCallId: Map<string, TranscriptToolCallView>,
  onNudge: (rule: RuleName) => void,
): void {
  const toolCallId = event.toolCallId;
  const detail = typeof toolCallId === "string" ? pendingByCallId.get(toolCallId) : undefined;
  if (detail === undefined) return;

  const resultText = toolResultTexts(event).join("\n");
  const cappedResult = capped(resultText);
  detail.result = cappedResult.text;
  detail.resultTruncated = cappedResult.truncated;
  detail.resultLineCount = lineCountOf(resultText);
  detail.isError = event.isError === true;

  const diff = detailsDiffOf(event.result);
  if (diff !== undefined) {
    const cappedDiff = capped(diff);
    detail.diff = cappedDiff.text;
    detail.diffTruncated = cappedDiff.truncated;
  }

  for (const rule of RULE_NAMES) {
    const occurrences = ruleMarkerOccurrences(resultText, `[${rule}]`);
    for (let i = 0; i < occurrences; i += 1) onNudge(rule);
  }
}

function applyMessageEnd(turnView: TranscriptTurnView, event: Record<string, unknown>): void {
  const message = event.message;
  if (typeof message !== "object" || message === null) return;
  const { role, content, stopReason } = message as Record<string, unknown>;

  if (role === "user") {
    turnView.userText = joinedTextOf(content);
    return;
  }
  if (role !== "assistant") return;

  turnView.assistantText = joinedTextOf(content);
  turnView.thinking = thinkingTextOf(content);
  turnView.isFinal = stopReason === "stop";
  turnView.isRetryFailure = stopReason === "error";
  const usage = usageOf(message as Record<string, unknown>);
  turnView.tokensIn = usage.input;
  turnView.tokensOut = usage.output;
}

export function buildTranscriptView(log: string): TranscriptView {
  const turnsByNumber = new Map<number, TranscriptTurnView>();
  const pendingByCallId = new Map<string, TranscriptToolCallView>();

  function turnFor(number: number): TranscriptTurnView {
    const existing = turnsByNumber.get(number);
    if (existing !== undefined) return existing;
    const created = emptyTurn(number);
    turnsByNumber.set(number, created);
    return created;
  }

  for (const { turn, event } of eventsWithTurnNumber(log)) {
    if (turn === 0) continue;
    const turnView = turnFor(turn);

    if (event.type === "tool_execution_start") applyToolExecutionStart(turnView, event, pendingByCallId);
    else if (event.type === "tool_execution_end") applyToolExecutionEnd(event, pendingByCallId, (rule) => turnView.nudges.push(rule));
    else if (event.type === "message_end") applyMessageEnd(turnView, event);
  }

  return { turns: [...turnsByNumber.values()], reasoningPresent: reasoningIsPresentIn(log) };
}
