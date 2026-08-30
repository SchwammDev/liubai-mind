import { readFileSync } from "node:fs";

import type { Lang, Nudge } from "./contract.ts";

export interface HelperConvention {
  pattern: string;
  root: string;
}

export interface CcNudgePhrasing {
  first: string;
  rest: string;
}

function coachingGuide(chain: string, idiom: string): CcNudgePhrasing {
  return {
    first: [
      "{name} is making too many decisions at once. The smell is not a number — the function has quietly taken on more than one job, and the count is only the symptom. Work through it in order:",
      "1. Say what the function does in one sentence. If you cannot, it has more than one responsibility; a branch with no place in that sentence wants its own function.",
      "2. Lift the guards out first: turn precondition checks into early-return guard clauses so the happy path reads flat.",
      `3. Change the shape, do not just move it: a long ${chain} on one value is usually a ${idiom}; branches that are genuinely different jobs become functions named for those jobs.`,
      "Do not split the same tangle into helpers to quiet a checker — that relocates decisions without removing any. The test is whether a first-time reader can hold the function in their head, not whether a number dropped.",
    ].join("\n"),
    rest: "{name}: same smell — apply the one-sentence test, lift guards first, reshape rather than relocate.",
  };
}

const DEFAULT_CC_NUDGE: Record<Lang, CcNudgePhrasing> = {
  python: coachingGuide("if/elif", "dispatch dict"),
  typescript: coachingGuide("if/else chain", "lookup object"),
  cpp: coachingGuide("if/else chain", "dispatch table"),
};

const KNOWN_LANGS: readonly Lang[] = ["python", "typescript", "cpp"];

function isLang(value: string): value is Lang {
  return (KNOWN_LANGS as readonly string[]).includes(value);
}

export function readPack(path: string | undefined, read: (p: string) => string): unknown {
  if (path === undefined) return {};
  try {
    return JSON.parse(read(path));
  } catch {
    return {};
  }
}

function asPhrasing(entry: unknown): CcNudgePhrasing | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { first, rest } = entry as Record<string, unknown>;
  if (typeof first !== "string" || typeof rest !== "string") return undefined;
  return { first, rest };
}

export function resolveCcNudge(
  defaults: Record<Lang, CcNudgePhrasing>,
  pack: unknown,
): Record<Lang, CcNudgePhrasing> {
  const resolved = { ...defaults };
  if (typeof pack !== "object" || pack === null) return resolved;

  const ccNudge = (pack as Record<string, unknown>).CC_NUDGE;
  if (typeof ccNudge !== "object" || ccNudge === null) return resolved;

  for (const [lang, entry] of Object.entries(ccNudge as Record<string, unknown>)) {
    if (!isLang(lang)) continue;
    const phrasing = asPhrasing(entry);
    if (phrasing === undefined) continue;
    resolved[lang] = phrasing;
  }
  return resolved;
}

export function formatCcNudge(template: string, facts: { name: string; cc: number; threshold: number }): string {
  return template
    .replaceAll("{name}", facts.name)
    .replaceAll("{cc}", String(facts.cc))
    .replaceAll("{threshold}", String(facts.threshold));
}

const DEFAULT_CC_DELTA_NUDGE =
  "{name} dropped below the complexity threshold, but the file still carries {dpAfter} decision points where it carried {dpBefore} — the complexity moved, it did not leave. Splitting a tangle into helpers relocates branches without removing any; a reader now chases the same decisions across more functions. Go back to the shape: collapse branches that repeat a pattern into a dispatch/lookup, delete branches the function's one-sentence job does not need, and only keep helpers that stand for a genuinely separate job.";

export function resolveCcDeltaNudge(defaultText: string, pack: unknown): string {
  if (typeof pack !== "object" || pack === null) return defaultText;

  const ccDeltaNudge = (pack as Record<string, unknown>).CC_DELTA_NUDGE;
  return typeof ccDeltaNudge === "string" ? ccDeltaNudge : defaultText;
}

export function formatCcDeltaNudge(template: string, facts: { name: string; dpBefore: number; dpAfter: number }): string {
  return template
    .replaceAll("{name}", facts.name)
    .replaceAll("{dpBefore}", String(facts.dpBefore))
    .replaceAll("{dpAfter}", String(facts.dpAfter));
}

const PARSED_PACK: unknown = readPack(process.env.LIUBAI_PHRASING_PACK, (p) => readFileSync(p, "utf8"));

export const CC_NUDGE: Record<Lang, CcNudgePhrasing> = resolveCcNudge(DEFAULT_CC_NUDGE, PARSED_PACK);

export const CC_DELTA_NUDGE: string = resolveCcDeltaNudge(DEFAULT_CC_DELTA_NUDGE, PARSED_PACK);

export const DOC_COMMENT_FORM: Record<Lang, string> = {
  python: "Remove docstrings too, not just '#' lines.",
  typescript: "Remove JSDoc blocks too, not just '//' lines.",
  cpp: "Remove Doxygen blocks too, not just '//' lines.",
};

export const ANNOTATION_ADVICE: Record<Lang, string> = {
  python: "Add hints for every parameter and the return type.",
  typescript: "Annotate every parameter and the return type; 'any' is not an annotation.",
  cpp: "Spell out parameter and return types instead of leaning on auto.",
};

export const TEST_LINEARITY_NUDGE = {
  first: "{name} branches — a test states one case as a straight line. An if/for here is either hidden cases (each branch is its own test; parametrize) or computation of the expected value (compute it by hand, state the literal).",
  rest: "{name}: same smell — branching in a test; one case per test, computed expectations stated as literals.",
};

export const TEST_ASSERT_PILE_NUDGE = {
  first: "{name} piles {n} raw asserts — the reader cannot see which comparison is the point. Name the concept they jointly check and hide them behind one intent-named helper (assert_tile_is_valid(tile)); one visible comparison is the norm, two already rare.",
  rest: "{name}: same smell — {n} raw asserts; hide them behind an intent-named helper.",
};

export const TEST_DATA_PLUMBING_NUDGE = {
  first: "{name} buries {n} lines of literal data — the case hides in the noise. Hoist the data to a named constant or builder whose name says what makes this data this case.",
  rest: "{name}: same smell — {n} lines of literal data; hoist to a named constant or builder.",
};

export function formatTestNudge(template: string, facts: { name: string; n: number }): string {
  return template
    .replaceAll("{name}", facts.name)
    .replaceAll("{n}", String(facts.n));
}

export const TEST_HELPERS: Record<Lang, HelperConvention> = {
  python: { pattern: "assert_*/_*", root: "tests/" },
  typescript: { pattern: "assert*/expect*", root: "*.test.ts" },
  cpp: { pattern: "Assert*/Expect*", root: "*_test.cpp" },
};

export const DISCOURAGE_COMMENTS_GUIDANCE =
  "Comments and docstrings are both noise here — write expressive code. " +
  "Remove docstrings too, not just '#' lines. " +
  "If you truly think a WHY-comment is justified, propose it to the user before writing it.";

export const TOOLING_DIRECTIVES_FOOTER =
  "Tooling directives are allowed and not blocked: '# ty: ignore[...]', '# type: ignore', '# noqa', '# pragma:', '# pyright:'.";

// The discourage-comments nudge embeds the comment snippet in its msg as
// `L{n}: "{snippet}" — …`; the block reason lists one line per added comment,
// so the snippet is peeled back out rather than re-extracting.
export function snippetFromNudgeMsg(msg: string): string {
  const marker = ': "';
  const start = msg.indexOf(marker);
  if (start === -1) return "";
  const rest = msg.slice(start + marker.length);
  const end = rest.indexOf('" —');
  return end === -1 ? rest : rest.slice(0, end);
}

export function formatBlockReason(path: string, blockNudges: Nudge[]): string {
  const lines = blockNudges
    .map((n) => `  L${n.line ?? "?"}: ${snippetFromNudgeMsg(n.msg) || "(comment)"}`)
    .join("\n");
  return `Blocked: new comments/docstrings detected in ${path}:\n${lines}\n\n${DISCOURAGE_COMMENTS_GUIDANCE}\n${TOOLING_DIRECTIVES_FOOTER}`;
}
