import type { CommentFacts, Exemption, Lang, Nudge, Rule, RuleConfig, RuleContext } from "./contract.ts";

export const RULE = {
  cc: "cc",
  typeAnnotation: "type-annotation",
  testBody: "test-body",
  discourageComments: "discourage-comments",
} as const;

export type { Exemption, RuleConfig } from "./contract.ts";

type RuleName = (typeof RULE)[keyof typeof RULE];

export type Policy = Record<RuleName, RuleConfig>;

export const DEFAULT_POLICY: Policy = {
  [RULE.cc]: {
    enabled: ["python", "typescript", "cpp"],
    severity: "nudge",
    threshold: { python: 8, typescript: 10, cpp: 12 },
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
      { langs: ["cpp"], paths: ["*.h", "*.hpp", "*.hh", "*.hxx"], kinds: ["doc"] },
    ],
  },
};

const ccRule = (cfg: RuleConfig): Rule => ({
  name: RULE.cc,
  run: (ctx: RuleContext): Nudge[] => {
    const threshold = cfg.threshold?.[ctx.lang];
    if (threshold === undefined) return [];

    const nudges: Nudge[] = [];
    for (const fn of ctx.extracted.functions) {
      if (!fn.bodyChanged) continue;
      if (fn.isTest) continue;
      if (fn.cyclomaticComplexity <= threshold) continue;

      nudges.push({
        rule: RULE.cc,
        severity: cfg.severity,
        line: fn.startLine,
        msg: `${fn.name} (CC=${fn.cyclomaticComplexity}). Threshold is ${threshold}. Extract guard clauses, split branches into named helpers, or replace if/elif chains with dispatch tables.`,
      });
    }
    return nudges;
  },
});

const testBodyRule = (cfg: RuleConfig): Rule => ({
  name: RULE.testBody,
  run: (ctx: RuleContext): Nudge[] => {
    const threshold = cfg.threshold?.[ctx.lang];
    if (threshold === undefined) return [];

    const flagged = ctx.extracted.functions.filter(
      (fn) => fn.isTest && fn.bodyChanged && fn.bodyLineCount > threshold,
    );
    if (flagged.length === 0) return [];

    const helpers = ctx.env.helpers?.();
    const hint = helpers !== undefined && helpers.length > 0
      ? ` Existing helpers: ${helpers.join(", ")}.`
      : ` No assert_*/_* helpers in tests/ yet — write one.`;

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
): Exemption | undefined {
  if (exemptions === undefined) return undefined;
  for (let i = 0; i < exemptions.length; i++) {
    const ex = exemptions[i]!;
    if (ex.langs !== undefined && !ex.langs.includes(lang)) continue;
    if (ex.paths !== undefined) {
      let matched = false;
      for (let p = 0; p < ex.paths.length; p++) {
        const pattern = ex.paths[p]!;
        const rest = pattern.startsWith("*") ? pattern.slice(1) : pattern;
        if (path.endsWith(rest)) { matched = true; break; }
      }
      if (!matched) continue;
    }
    if (ex.kinds !== undefined && !ex.kinds.includes(kind)) continue;
    return ex;
  }
  return undefined;
}

const discourageCommentsRule = (cfg: RuleConfig): Rule => ({
  name: RULE.discourageComments,
  run: (ctx: RuleContext): Nudge[] => {
    const nudges: Nudge[] = [];
    for (const cmnt of ctx.extracted.comments) {
      if (!cmnt.added) continue;
      if (cmnt.kind === "tooling") continue;
      if (matchesExemption(ctx.path, ctx.lang, cmnt.kind, cfg.exemptions) !== undefined) continue;

      const raw = cmnt.text.trimStart();
      const snippet = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
      nudges.push({
        rule: RULE.discourageComments,
        severity: cfg.severity,
        line: cmnt.line,
        msg: `L${cmnt.line}: "${snippet}" — comments are noise; write expressive code. Remove docstrings too, not just '#' lines. If you truly think a WHY-comment is justified, propose it to the user before writing it.`,
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
      if (!fn.signatureChanged) continue;
      if (fn.missingAnnotations.length === 0) continue;
      nudges.push({
        rule: RULE.typeAnnotation,
        severity: cfg.severity,
        line: fn.startLine,
        msg: `${fn.name}: missing ${fn.missingAnnotations.join(", ")}. Add hints for every parameter and the return type.`,
      });
    }
    return nudges;
  },
});

const IMPLS: Partial<Record<string, (cfg: RuleConfig) => Rule>> = {
  [RULE.cc]: ccRule,
  [RULE.typeAnnotation]: typeAnnotationRule,
  [RULE.testBody]: testBodyRule,
  [RULE.discourageComments]: discourageCommentsRule,
};

const RULE_ORDER: RuleName[] = [
  RULE.cc,
  RULE.typeAnnotation,
  RULE.testBody,
  RULE.discourageComments,
];

export function buildRules(policy: Policy, lang: Lang): Rule[] {
  const rules: Rule[] = [];
  for (const name of RULE_ORDER) {
    const cfg = policy[name];
    if (cfg === undefined) continue;
    if (!cfg.enabled.includes(lang)) continue;
    const factory = IMPLS[name];
    if (factory === undefined) continue;
    rules.push(factory(cfg));
  }
  return rules;
}
