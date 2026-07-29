import type { AnalyzeReq, AnalyzeResp, Env, Extracted, Lang, RailError, Rule, RuleContext } from "./contract.ts";
import { detectLang } from "./lang.ts";
import { shouldSkip } from "./prefilter.ts";

const emptyResp = (): AnalyzeResp => ({ nudges: [], errors: [] });
const emptyExtracted: Extracted = { functions: [], comments: [] };

async function extractFacts(
  req: AnalyzeReq,
  lang: Lang,
  env: Env,
  errors: RailError[],
): Promise<Extracted> {
  const extractor = env.extractors?.[lang];
  if (extractor === undefined) return emptyExtracted;

  try {
    return await extractor.extract({ path: req.path, ...(req.before !== undefined ? { before: req.before } : {}), after: req.after });
  } catch (err) {
    errors.push({ source: `extract:${lang}`, msg: String(err) });
    return emptyExtracted;
  }
}

export async function analyze(req: AnalyzeReq, env: Env, rules: readonly Rule[]): Promise<AnalyzeResp> {
  const lang = req.lang ?? detectLang(req.path);
  if (lang === undefined) return emptyResp();

  if (shouldSkip(req.path, req.after)) return emptyResp();

  const nudges: AnalyzeResp["nudges"] = [];
  const errors: AnalyzeResp["errors"] = [];
  const extracted = await extractFacts(req, lang, env, errors);

  const ctx: RuleContext = {
    path: req.path,
    lang,
    after: req.after,
    env,
    extracted,
    ...(req.before !== undefined ? { before: req.before } : {}),
  };

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
