export type Lang = "python" | "typescript" | "cpp";
export type Severity = "block" | "nudge";

export const RULE = {
  cc: "cc",
  typeAnnotation: "type-annotation",
  testBody: "test-body",
  discourageComments: "discourage-comments",
} as const;

export type RuleName = (typeof RULE)[keyof typeof RULE];

export interface Nudge { rule: RuleName; msg: string; severity: Severity; line?: number }
export interface RailError { source: string; msg: string }
export interface AnalyzeReq { path: string; after: string; before?: string; lang?: Lang }
export interface AnalyzeResp { nudges: Nudge[]; errors: RailError[] }

export interface Extracted {
  functions: FunctionFacts[];
  comments: CommentFacts[];
}

export type Change = "new" | "changed" | "same";

export interface FunctionFacts {
  name: string;
  startLine: number;
  cyclomaticComplexity: number;
  missingAnnotations: string[];
  isTest: boolean;
  bodyLineCount: number;
  signature: Change;
  body: Change;
}

export interface CommentFacts {
  line: number;
  text: string;
  kind: "line" | "doc" | "block" | "tooling";
  added: boolean;
}

export interface Extractor {
  extract(input: { before?: string; after: string }): Extracted | Promise<Extracted>;
}

export interface Env {
  extractors?: Partial<Record<Lang, Extractor>>;
  helpers?: (lang: Lang) => string[];
}

export interface RuleContext {
  path: string;
  lang: Lang;
  after: string;
  before?: string;
  env: Env;
  extracted: Extracted;
}

export interface Rule { name: string; run(ctx: RuleContext): Nudge[] | Promise<Nudge[]> }

export type Exemption = {
  langs?: Lang[];
  pathSuffixes?: string[];
  kinds?: CommentFacts["kind"][];
};

export type RuleConfig = {
  enabled: Lang[];
  severity: Severity;
  threshold?: Record<Lang, number>;
  exemptions?: Exemption[];
};
