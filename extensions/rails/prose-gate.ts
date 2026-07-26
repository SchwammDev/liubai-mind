// The 留白 lever: deterministically strip known filler from assistant prose.
// Models are trained to be additive — sycophantic openers, closing pleasantries,
// hedge preambles. None of it earns its tokens. Removal here is high-precision by
// design: a false strip costs meaning, so the blocklist stays conservative and
// every pattern is anchored tightly enough to leave real prose untouched.

const SENTENCE_START = String.raw`(?:^|(?<=[.!?]\s)|(?<=\n))`;

function sentenceInitial(body: string): RegExp {
  return new RegExp(`${SENTENCE_START}(?:${body})\\s*`, "gi");
}

const FILLER: RegExp[] = [
  sentenceInitial(String.raw`(?:great|good|excellent) (?:question|point)[.!]`),
  sentenceInitial(String.raw`(?:certainly|absolutely|of course)[.!,]`),
  sentenceInitial(String.raw`(?:it'?s|it is) (?:worth|important) (?:noting|to note) that`),
  /\b(?:i hope|hope)(?: that| this)? helps[.!]?\s*/gi,
  /\blet me know if (?:you have any questions|you need anything else|there'?s anything else)[.!]?\s*/gi,
  /\bfeel free to (?:ask|reach out)[^.!\n]*[.!]\s*/gi,
];

function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
    .replace(/^\p{Ll}/u, (first) => first.toUpperCase());
}

export function stripFiller(prose: string): string {
  let stripped = prose;
  for (const pattern of FILLER) stripped = stripped.replace(pattern, "");
  return tidy(stripped);
}

type TextPart = { type: "text"; text: string };
type MessagePart = TextPart | { type: string };
type Message = { role: string; content: MessagePart[] };

const isText = (part: MessagePart): part is TextPart => part.type === "text";

// The gate touches assistant prose only — thinking and tool-call parts are the
// agent's private reasoning and machine payloads, off-limits to the lever.
export function cleanProse<T extends Message>(message: T): T {
  if (message.role !== "assistant") return message;
  const content = message.content.map((part) =>
    isText(part) ? { ...part, text: stripFiller(part.text) } : part,
  );
  return { ...message, content };
}
