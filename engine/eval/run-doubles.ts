import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RawRow } from "./eval-contract.ts";
import { RULE } from "../contract.ts";
import type { RuleName } from "../contract.ts";

export const CORPUS_DIR = join(import.meta.dirname, "corpus");
export const TREATMENTS_DIR = join(import.meta.dirname, "treatments");

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function pristineSourceOf(caseId: string, entryFile: string): string {
  return readFileSync(join(CORPUS_DIR, caseId, `${entryFile}.case`), "utf8");
}

export function nudgeCounts(fired: Partial<Record<RuleName, number>>): Record<RuleName, number> {
  const rules = Object.values(RULE) as RuleName[];
  return Object.fromEntries(rules.map((rule) => [rule, fired[rule] ?? 0])) as Record<RuleName, number>;
}

export function turnStart(): string {
  return JSON.stringify({ type: "turn_start" });
}

export function toolCall(toolName: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "tool_execution_start", toolCallId: "t", toolName, args });
}

export function nudgeFired(rule: RuleName): string {
  const result = { content: [{ type: "text", text: `[${rule}] the complexity moved, it did not leave` }] };
  return JSON.stringify({ type: "tool_execution_end", toolCallId: "t", toolName: "edit", result, isError: false });
}

export function assistantSaid(text: string): string {
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
}

export function assistantThought(thinking: string): string {
  return JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking }] } });
}

export function userSaid(text: string): string {
  return JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
}

export function assistantMessage(over: { text?: string; thinking?: string; stopReason?: string; tokensIn?: number; tokensOut?: number } = {}): string {
  const content: Record<string, unknown>[] = [];
  if (over.text !== undefined) content.push({ type: "text", text: over.text });
  if (over.thinking !== undefined) content.push({ type: "thinking", thinking: over.thinking });

  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content,
      stopReason: over.stopReason ?? "stop",
      usage: { input: over.tokensIn ?? 0, output: over.tokensOut ?? 0 },
    },
  });
}

export function toolCallResult(toolName: string, text: string, over: { isError?: boolean; diff?: string } = {}): string {
  const result: Record<string, unknown> = { content: [{ type: "text", text }] };
  if (over.diff !== undefined) result.details = { diff: over.diff };
  return JSON.stringify({ type: "tool_execution_end", toolCallId: "t", toolName, result, isError: over.isError ?? false });
}

export function sessionLog(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

export function writeRun(runDir: string, rows: RawRow[], sessionLogs: Record<string, string>): string {
  mkdirSync(join(runDir, "transcripts"), { recursive: true });
  writeFileSync(join(runDir, "raw.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  for (const [name, log] of Object.entries(sessionLogs)) writeFileSync(join(runDir, "transcripts", name), log);
  return runDir;
}

export function singleTaskSessionLogName(caseId: string, treatmentId: string, repetition: number): string {
  return `${caseId}.${treatmentId}.${repetition}.jsonl`;
}

export function followUpSessionLogName(caseId: string, treatmentId: string, sourceRepetition: number | null): string {
  const suffix = sourceRepetition === null ? "control" : `from-repetition-${sourceRepetition}`;
  return `${caseId}.${treatmentId}.${suffix}.jsonl`;
}
