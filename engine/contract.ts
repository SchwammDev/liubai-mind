export type Lang = "python" | "typescript" | "cpp";
export type Severity = "block" | "nudge";
export interface Nudge { rule: string; msg: string; severity: Severity; line?: number }
export interface RailError { source: string; msg: string }
export interface AnalyzeReq { path: string; after: string; before?: string; lang?: Lang }
export interface AnalyzeResp { nudges: Nudge[]; errors: RailError[] }

export interface Extracted {
  functions: FunctionFacts[];
  comments: CommentFacts[];
}

export interface FunctionFacts {
  id: string;
  name: string;
  startLine: number;
  endLine: number;
  cyclomaticComplexity: number;
  missingAnnotations: string[];
  isTest: boolean;
  bodyLineCount: number;
  signatureChanged: boolean;
  bodyChanged: boolean;
}

export interface CommentFacts {
  line: number;
  text: string;
  kind: "line" | "doc" | "block" | "tooling";
  added: boolean;
}

export interface Extractor {
  extract(input: { before?: string; after: string }): Extracted;
}

export interface Env {
  extractors?: Partial<Record<Lang, Extractor>>;
  helpers?: () => string[];
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
  paths?: string[];
  kinds?: CommentFacts["kind"][];
};

export type RuleConfig = {
  enabled: Lang[];
  severity: Severity;
  threshold?: Partial<Record<Lang, number>>;
  exemptions?: Exemption[];
};