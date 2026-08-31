interface ToolCallPart {
  name: string;
  arguments: unknown;
}

function isToolCallPart(part: unknown): part is ToolCallPart {
  return typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "toolCall";
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function assistantMessageOf(line: string): Record<string, unknown> | undefined {
  const parsed = parseJsonLine(line);
  if (typeof parsed !== "object" || parsed === null) return undefined;

  const event = parsed as Record<string, unknown>;
  if (event.type !== "message_end") return undefined;
  if (typeof event.message !== "object" || event.message === null) return undefined;

  const message = event.message as Record<string, unknown>;
  return message.role === "assistant" ? message : undefined;
}

function assistantToolCallsOf(line: string): ToolCallPart[] {
  const message = assistantMessageOf(line);
  if (message === undefined || !Array.isArray(message.content)) return [];

  return message.content.filter(isToolCallPart);
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) collectStrings(nested, out);
  }
}

function toolCallStrings(toolCall: ToolCallPart): string[] {
  const strings: string[] = [];
  collectStrings(toolCall.arguments, strings);
  return strings;
}

function transcriptToolCallStrings(transcriptJsonl: string): string[] {
  const lines = transcriptJsonl.split("\n").filter((line) => line.trim().length > 0);

  const strings: string[] = [];
  for (const line of lines) {
    for (const toolCall of assistantToolCallsOf(line)) {
      strings.push(...toolCallStrings(toolCall));
    }
  }
  return strings;
}

function matchesAnyPrefix(strings: string[], prefixes: string[]): boolean {
  return strings.some((s) => prefixes.some((prefix) => s.includes(prefix)));
}

export function transcriptIsContaminated(transcriptJsonl: string, harnessPathPrefixes: string[]): boolean {
  return matchesAnyPrefix(transcriptToolCallStrings(transcriptJsonl), harnessPathPrefixes);
}

export interface TranscriptClassification {
  contaminated: boolean;
  consultedRail: boolean;
}

export function classifyTranscript(
  transcriptJsonl: string,
  opts: { answerKeyPrefixes: string[]; railPrefixes: string[] },
): TranscriptClassification {
  const strings = transcriptToolCallStrings(transcriptJsonl);
  const contaminated = matchesAnyPrefix(strings, opts.answerKeyPrefixes);
  const consultedRail = !contaminated && matchesAnyPrefix(strings, opts.railPrefixes);
  return { contaminated, consultedRail };
}
