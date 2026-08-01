import type { CommentFacts, Exemption, Lang, Nudge, Rule, RuleConfig, RuleContext, RuleName } from "./contract.ts";
import { RULE } from "./contract.ts";
import { ANNOTATION_ADVICE, CC_ADVICE, DOC_COMMENT_FORM, TEST_HELPERS } from "./messages.ts";

export { RULE } from "./contract.ts";
export type { Exemption, RuleConfig, RuleName } from "./contract.ts";

export type Policy = Record<RuleName, RuleConfig>;

export const DEFAULT_POLICY: Policy = {
  [RULE.cc]: {
    enabled: ["python", "typescript", "cpp"],
    severity: "nudge",
    threshold: { python: 8, typescript: 8, cpp: 8 },
  },
  [RULE.typeAnnotation]: {
    enabled: ["python"],
    severity: "nudge",
  },
  [RULE.testBody]: {
    enabled: ["python", "typescript", "cpp"],
    severity: "nudge",
    threshold: { python: 8, typescript: 8, cpp: 8 },
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

    const nudges: Nudge[] = [];
    for (const fn of ctx.extracted.functions) {
      if (fn.body === "same") continue;
      if (fn.cyclomaticComplexity <= threshold) continue;

      nudges.push({
        rule: RULE.cc,
        severity: cfg.severity,
        line: fn.startLine,
        msg: `${fn.name} (CC=${fn.cyclomaticComplexity}). Threshold is ${threshold}. Extract guard clauses, split branches into named helpers, or ${CC_ADVICE[ctx.lang]}.`,
      });
    }
    return nudges;
  },
});

function helperHint(lang: Lang, helpers: string[] | undefined): string {
  if (helpers !== undefined && helpers.length > 0) {
    return ` Existing helpers: ${helpers.join(", ")}.`;
  }
  const convention = TEST_HELPERS[lang];
  return ` No ${convention.pattern} helpers in ${convention.root} yet — write one.`;
}

const testBodyRule = (cfg: RuleConfig): Rule => ({
  name: RULE.testBody,
  run: (ctx: RuleContext): Nudge[] => {
    const threshold = thresholdFor(RULE.testBody, cfg, ctx.lang);

    const flagged = ctx.extracted.functions.filter(
      (fn) => fn.isTest && fn.body !== "same" && fn.bodyLineCount > threshold,
    );
    if (flagged.length === 0) return [];

    const hint = helperHint(ctx.lang, ctx.env.helpers?.(ctx.lang));

    const nudges: Nudge[] = [];
    for (let i = 0; i < flagged.length; i++) {
      const fn = flagged[i]!;
      const base = `${fn.name} (${fn.bodyLineCount}L). Long test: hide asserts behind intent-named helpers; extract setup. Threshold is ${threshold}.`;
      nudges.push({
        rule: RULE.testBody,
        severity: cfg.severity,
        line: fn.startLine,
        msg: i === 0 ? base + hint : base,
      });
    }
    return nudges;
  },
});

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
  [RULE.typeAnnotation]: typeAnnotationRule,
  [RULE.testBody]: testBodyRule,
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
