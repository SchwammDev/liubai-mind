export type Lang = "python" | "typescript" | "cpp";
export type Severity = "block" | "nudge";
export interface Nudge { rule: string; msg: string; severity: Severity; line?: number }
export interface RailError { source: string; msg: string }
export interface AnalyzeReq { path: string; after: string; before?: string; lang?: Lang }
export interface AnalyzeResp { nudges: Nudge[]; errors: RailError[] }
/** Extraction ports — populated by #19 (extract) and #20 (cc). */
export interface Env {}
export interface RuleContext { path: string; lang: Lang; after: string; before?: string; env: Env }
export interface Rule { name: string; run(ctx: RuleContext): Nudge[] | Promise<Nudge[]> }
