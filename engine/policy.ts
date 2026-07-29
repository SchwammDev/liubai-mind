import type { Lang, Nudge, Rule, RuleConfig, RuleContext } from "./contract.ts";

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

const IMPLS: Partial<Record<string, (cfg: RuleConfig) => Rule>> = {
  [RULE.cc]: ccRule,
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
