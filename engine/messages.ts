import type { Lang } from "./contract.ts";

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
