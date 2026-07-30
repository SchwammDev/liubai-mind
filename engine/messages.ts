import type { Lang, Nudge } from "./contract.ts";

export interface HelperConvention {
  pattern: string;
  root: string;
}

export const CC_ADVICE: Record<Lang, string> = {
  python: "replace if/elif chains with dispatch dicts",
  typescript: "replace if/else chains with lookup objects",
  cpp: "replace if/else chains with dispatch tables",
};

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
