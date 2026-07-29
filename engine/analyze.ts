import type { AnalyzeReq, AnalyzeResp, Env, Rule, RuleContext } from "./contract.ts";
import { detectLang } from "./lang.ts";
import { shouldSkip } from "./prefilter.ts";

const emptyResp = (): AnalyzeResp => ({ nudges: [], errors: [] });

export async function analyze(req: AnalyzeReq, env: Env, rules: readonly Rule[]): Promise<AnalyzeResp> {
  const lang = req.lang ?? detectLang(req.path);
  if (lang === undefined) return emptyResp();

  if (shouldSkip(req.path, req.after)) return emptyResp();

  const ctx: RuleContext = {
    path: req.path,
    lang,
    after: req.after,
    env,
    ...(req.before !== undefined ? { before: req.before } : {}),
  };

  const nudges: AnalyzeResp["nudges"] = [];
  const errors: AnalyzeResp["errors"] = [];

  for (const rule of rules) {
    try {
      const produced = await rule.run(ctx);
      nudges.push(...produced);
    } catch (err) {
      errors.push({ source: rule.name, msg: String(err) });
    }
  }

  return { nudges, errors };
}
