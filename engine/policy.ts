import type { CommentFacts, Exemption, FunctionFacts, Lang, Nudge, Rule, RuleConfig, RuleContext, RuleName } from "./contract.ts";
import { RULE } from "./contract.ts";
import { decisionPoints } from "./decision-points.ts";
import { ANNOTATION_ADVICE, CC_DELTA_NUDGE, CC_NUDGE, DOC_COMMENT_FORM, TEST_ASSERT_PILE_NUDGE, TEST_DATA_PLUMBING_NUDGE, TEST_HELPERS, TEST_LINEARITY_NUDGE, formatCcDeltaNudge, formatCcNudge, formatTestNudge } from "./messages.ts";

export { RULE } from "./contract.ts";
export type { Exemption, RuleConfig, RuleName } from "./contract.ts";

export type Policy = Record<RuleName, RuleConfig>;

export const DEFAULT_POLICY: Policy = {
  [RULE.cc]: {
    enabled: ["python", "typescript", "cpp"],
    severity: "nudge",
    threshold: { python: 8, typescript: 8, cpp: 8 },
  },
  [RULE.ccDelta]: {
    enabled: ["python", "typescript"],
    severity: "nudge",
    threshold: { python: 8, typescript: 8, cpp: 8 },
  },
  [RULE.typeAnnotation]: {
    enabled: ["python"],
    severity: "nudge",
  },
  [RULE.testLinearity]: {
    enabled: ["python", "typescript"],
    severity: "nudge",
    threshold: { python: 0, typescript: 0, cpp: 0 },
  },
  [RULE.testAssertPile]: {
    enabled: ["python", "typescript"],
    severity: "nudge",
    threshold: { python: 2, typescript: 2, cpp: 2 },
  },
  [RULE.testDataPlumbing]: {
    enabled: ["python", "typescript"],
    severity: "nudge",
    threshold: { python: 6, typescript: 6, cpp: 6 },
  },
  [RULE.discourageComments]: {
    enabled: ["python", "typescript", "cpp"],
    severity: "block",
    exemptions: [
      { langs: ["cpp"], pathSuffixes: [".h", ".hpp", ".hh", ".hxx"], kinds: ["doc"] },
    ],
  },
};

function thresholdFor(rule: RuleName, cfg: RuleConfig, lang: Lang): number {
  const threshold = cfg.threshold?.[lang];
  if (threshold === undefined) {
    throw new Error(`${rule} is enabled for ${lang} but carries no threshold for it`);
  }
  return threshold;
}

const ccRule = (cfg: RuleConfig): Rule => ({
  name: RULE.cc,
  run: (ctx: RuleContext): Nudge[] => {
    const threshold = thresholdFor(RULE.cc, cfg, ctx.lang);
    const phrasing = CC_NUDGE[ctx.lang];

    const nudges: Nudge[] = [];
    for (const fn of ctx.extracted.functions) {
      if (fn.body === "same") continue;
      if (fn.cyclomaticComplexity <= threshold) continue;

      const template = nudges.length === 0 ? phrasing.first : phrasing.rest;
      nudges.push({
        rule: RULE.cc,
        severity: cfg.severity,
        line: fn.startLine,
        msg: formatCcNudge(template, { name: fn.name, cc: fn.cyclomaticComplexity, threshold }),
      });
    }
    return nudges;
  },
});

const ccDeltaRule = (cfg: RuleConfig): Rule => ({
  name: RULE.ccDelta,
  run: (ctx: RuleContext): Nudge[] => {
    const before = ctx.extracted.beforeFunctions;
    if (before === undefined) return [];

    const threshold = thresholdFor(RULE.ccDelta, cfg, ctx.lang);
    const overBefore = before.filter((fn) => fn.cyclomaticComplexity > threshold);
    if (overBefore.length === 0) return [];

    const stillOver = ctx.extracted.functions.some((fn) => fn.cyclomaticComplexity > threshold);
    if (stillOver) return [];

    const dpBefore = decisionPoints(before);
    const dpAfter = decisionPoints(ctx.extracted.functions);
    if (dpAfter < dpBefore) return [];

    const name = overBefore.map((fn) => fn.name).join(", ");
    return [{
      rule: RULE.ccDelta,
      severity: cfg.severity,
      msg: formatCcDeltaNudge(CC_DELTA_NUDGE, { name, dpBefore, dpAfter }),
    }];
  },
});

function helperHint(lang: Lang, helpers: string[] | undefined): string {
  if (helpers !== undefined && helpers.length > 0) {
    return ` Existing helpers: ${helpers.join(", ")}.`;
  }
  const convention = TEST_HELPERS[lang];
  return ` No ${convention.pattern} helpers in ${convention.root} yet — write one.`;
}

function testFactRule(
  name: RuleName,
  factOf: (fn: FunctionFacts) => number,
  phrasing: { first: string; rest: string },
  useHelperHint: boolean,
): (cfg: RuleConfig) => Rule {
  return (cfg: RuleConfig): Rule => ({
    name,
    run: (ctx: RuleContext): Nudge[] => {
      const threshold = thresholdFor(name, cfg, ctx.lang);

      const flagged = ctx.extracted.functions.filter(
        (fn) => fn.isTest && fn.body !== "same" && factOf(fn) > threshold,
      );
      if (flagged.length === 0) return [];

      const hint = useHelperHint ? helperHint(ctx.lang, ctx.env.helpers?.(ctx.lang)) : "";

      const nudges: Nudge[] = [];
      for (let i = 0; i < flagged.length; i++) {
        const fn = flagged[i]!;
        const template = i === 0 ? phrasing.first : phrasing.rest;
        const base = formatTestNudge(template, { name: fn.name, n: factOf(fn) });
        nudges.push({
          rule: name,
          severity: cfg.severity,
          line: fn.startLine,
          msg: i === 0 && useHelperHint ? base + hint : base,
        });
      }
      return nudges;
    },
  });
}

const testLinearityRule = testFactRule(RULE.testLinearity, (fn) => fn.controlStatementCount, TEST_LINEARITY_NUDGE, false);
const testAssertPileRule = testFactRule(RULE.testAssertPile, (fn) => fn.rawAssertCount, TEST_ASSERT_PILE_NUDGE, true);
const testDataPlumbingRule = testFactRule(RULE.testDataPlumbing, (fn) => fn.plumbingLines, TEST_DATA_PLUMBING_NUDGE, false);

function matchesExemption(
  path: string,
  lang: Lang,
  kind: CommentFacts["kind"],
  exemptions?: Exemption[],
): boolean {
  if (exemptions === undefined) return false;
  return exemptions.some((ex) => {
    if (ex.langs !== undefined && !ex.langs.includes(lang)) return false;
    if (ex.pathSuffixes !== undefined && !ex.pathSuffixes.some((suffix) => path.endsWith(suffix))) return false;
    if (ex.kinds !== undefined && !ex.kinds.includes(kind)) return false;
    return true;
  });
}

const discourageCommentsRule = (cfg: RuleConfig): Rule => ({
  name: RULE.discourageComments,
  run: (ctx: RuleContext): Nudge[] => {
    const nudges: Nudge[] = [];
    for (const cmnt of ctx.extracted.comments) {
      if (!cmnt.added) continue;
      if (cmnt.kind === "tooling") continue;
      if (matchesExemption(ctx.path, ctx.lang, cmnt.kind, cfg.exemptions)) continue;

      const raw = cmnt.text.trimStart();
      const snippet = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
      nudges.push({
        rule: RULE.discourageComments,
        severity: cfg.severity,
        line: cmnt.line,
        msg: `L${cmnt.line}: "${snippet}" — comments are noise; write expressive code. ${DOC_COMMENT_FORM[ctx.lang]} If you truly think a WHY-comment is justified, propose it to the user before writing it.`,
      });
    }
    return nudges;
  },
});

const typeAnnotationRule = (cfg: RuleConfig): Rule => ({
  name: RULE.typeAnnotation,
  run: (ctx: RuleContext): Nudge[] => {
    const nudges: Nudge[] = [];
    for (const fn of ctx.extracted.functions) {
      if (fn.signature === "same") continue;
      if (fn.missingAnnotations.length === 0) continue;
      nudges.push({
        rule: RULE.typeAnnotation,
        severity: cfg.severity,
        line: fn.startLine,
        msg: `${fn.name}: missing ${fn.missingAnnotations.join(", ")}. ${ANNOTATION_ADVICE[ctx.lang]}`,
      });
    }
    return nudges;
  },
});

const IMPLS: Record<RuleName, (cfg: RuleConfig) => Rule> = {
  [RULE.cc]: ccRule,
  [RULE.ccDelta]: ccDeltaRule,
  [RULE.typeAnnotation]: typeAnnotationRule,
  [RULE.testLinearity]: testLinearityRule,
  [RULE.testAssertPile]: testAssertPileRule,
  [RULE.testDataPlumbing]: testDataPlumbingRule,
  [RULE.discourageComments]: discourageCommentsRule,
};

const RULE_ORDER: readonly RuleName[] = Object.values(RULE);

export function buildRules(policy: Policy, lang: Lang): Rule[] {
  const rules: Rule[] = [];
  for (const name of RULE_ORDER) {
    const cfg = policy[name];
    if (!cfg.enabled.includes(lang)) continue;
    rules.push(IMPLS[name](cfg));
  }
  return rules;
}
