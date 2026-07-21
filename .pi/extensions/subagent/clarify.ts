import type { SingleResult, ReportAssessment } from "./child.ts";
import type { ChildSession, ChildTransport } from "./bridge.ts";
import {
  CLARIFY_TIMEOUT_MS,
  compressPrompt,
  gateReport,
  getFinalOutput,
  getResultOutput,
  hardTruncateReport,
  isFailedResult,
  truncationNotice,
} from "./child.ts";

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  details: { mode: "single"; results: SingleResult[] };
  isError?: boolean;
}

const askText = (question: string) =>
  `Child asks: ${question}\n\nCall \`answer(text=…)\` to reply.`;

export function spawnBlockedResult(): ToolResult {
  return {
    content: [{ type: "text", text: "A spawned child is awaiting an answer. Call `answer(text=…)` before spawning another." }],
    details: { mode: "single", results: [] },
    isError: true,
  };
}

export function singleSpawnResult(outcome: RunChildOutcome): ToolResult {
  if (outcome.kind === "suspended") {
    return {
      content: [{ type: "text", text: askText(outcome.clarify.question) }],
      details: { mode: "single", results: [outcome.result] },
    };
  }
  const result = outcome.result;
  if (isFailedResult(result)) {
    return {
      content: [{ type: "text", text: `Child ${result.stopReason || "failed"}: ${getResultOutput(result)}` }],
      details: { mode: "single", results: [result] },
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: result.finalReport || getFinalOutput(result.messages) || "(no output)" }],
    details: { mode: "single", results: [result] },
  };
}

export function answerToolResult(outcome: AnswerOutcome): ToolResult {
  if (outcome.kind === "ask") {
    return {
      content: [{ type: "text", text: askText(outcome.question) }],
      details: { mode: "single", results: [outcome.result] },
 };
  }
  if (outcome.kind === "done") {
    return {
      content: [{ type: "text", text: outcome.report }],
      details: { mode: "single", results: [outcome.result] },
      isError: outcome.failed,
    };
  }
  return {
    content: [{ type: "text", text: outcome.text }],
    details: { mode: "single", results: [] },
  };
}

export type ChildUpdate = (result: SingleResult) => void;

export type RunChildOutcome =
  | { kind: "done"; result: SingleResult }
  | { kind: "suspended"; clarify: { id: string; question: string }; result: SingleResult };

export type AnswerOutcome =
  | { kind: "ask"; question: string; result: SingleResult }
  | { kind: "done"; report: string; result: SingleResult; failed: boolean }
  | { kind: "none"; text: string };

export interface SuspendedState {
  clarifyId: string;
  question: string;
  transport: ChildTransport;
  session: ChildSession;
  result: SingleResult;
  budget: { delivered: number };
  onUpdate: ChildUpdate | undefined;
  mode: "single" | "parallel";
  timer: ReturnType<typeof setTimeout> | null;
  finished: boolean;
  finalReport?: string;
  signal?: AbortSignal;
  abortHandler?: (() => void) | null;
}

let suspended: SuspendedState | null = null;
let lateReport: string | null = null;

export function getSuspended(): SuspendedState | null {
  return suspended;
}

export function __getLateReport(): string | null {
  return lateReport;
}

export function __setSuspended(state: SuspendedState | null): void {
  suspended = state;
}

export function __resetClarifyState(): void {
  if (suspended?.timer) {
    clearTimeout(suspended.timer);
    suspended.timer = null;
  }
  suspended = null;
  lateReport = null;
}

// The compress bounce runs only after final settlement (never on suspend), so it
// is shared by runChild's final path and the clarify resume path. Lives here to
// keep index.ts (which imports pi-tui) thin and this module standalone-testable.
export async function gateChildReport(
  result: SingleResult,
  session: ChildSession,
  onUpdate: ChildUpdate | undefined,
): Promise<void> {
  const emitUpdate = () => onUpdate?.(result);

  const rawReport = getFinalOutput(result.messages);
  if (rawReport === "") {
    result.finalReport = "";
    return;
  }

  const compress = async (report: string): Promise<string> => {
    const r = await session.sendPrompt(compressPrompt(report));
    emitUpdate();
    if (!r.settled) throw new Error("compress turn did not settle");
    return getFinalOutput(result.messages);
  };

  let gated: { report: string; verdict: ReportAssessment };
  try {
    gated = await gateReport(rawReport, undefined, compress);
  } catch (e) {
    const { report: body, omitted } = hardTruncateReport(rawReport);
    gated = { report: body, verdict: { kind: "truncated", bytes: omitted } };
    result.stderr += `\n[compress bounce failed: ${e instanceof Error ? e.message : String(e)}; fell back to hard-truncate]`;
  }

  result.finalReport =
    gated.verdict.kind === "truncated"
      ? `${gated.report}\n\n${truncationNotice(gated.verdict.bytes)}`
      : gated.report;
}

export function startClarifyTimer(state: SuspendedState): void {
  state.timer = setTimeout(() => {
    void onClarifyTimeout(state);
  }, CLARIFY_TIMEOUT_MS);
}

function removeAbortListener(state: SuspendedState): void {
  if (state.abortHandler && state.signal) {
    state.signal.removeEventListener("abort", state.abortHandler);
    state.abortHandler = null;
  }
}

export function wireAbortDuringSuspend(state: SuspendedState, signal?: AbortSignal): void {
  if (!signal) return;
  state.signal = signal;
  const onAbort = () => {
    if (suspended !== state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.transport.kill();
    state.result.settled = false;
    state.result.exitCode = 1;
    state.result.stopReason = "aborted";
    state.finished = true;
    state.finalReport = getResultOutput(state.result);
    lateReport = state.finalReport;
    suspended = null;
    signal.removeEventListener("abort", onAbort);
  };
  state.abortHandler = onAbort;
  signal.addEventListener("abort", onAbort, { once: true });
}

export function initSuspend(state: SuspendedState, signal?: AbortSignal): void {
  suspended = state;
  startClarifyTimer(state);
  wireAbortDuringSuspend(state, signal);
}

export async function completeClarify(state: SuspendedState, value: string): Promise<RunChildOutcome> {
  state.transport.write(JSON.stringify({ type: "extension_ui_response", id: state.clarifyId, value }));
  const t = await state.session.resume();

  if (t.suspended && t.clarify) {
    state.clarifyId = t.clarify.id;
    state.question = t.clarify.question;
    return { kind: "suspended", clarify: t.clarify, result: state.result };
  }

  state.result.settled = t.settled;
  state.result.exitCode = t.exitCode;
  if (!t.settled) state.result.errorMessage ??= `child exited (code ${t.exitCode}) before completing its turn`;
  if (t.settled && !isFailedResult(state.result)) {
    await gateChildReport(state.result, state.session, state.onUpdate);
  }
  state.session.close();
  return { kind: "done", result: state.result };
}

export async function onClarifyTimeout(state: SuspendedState): Promise<void> {
  if (suspended !== state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  const outcome = await completeClarify(state, "proceed with best judgment");

  if (outcome.kind === "suspended") {
    state.clarifyId = outcome.clarify.id;
    state.question = outcome.clarify.question;
    startClarifyTimer(state);
    return;
  }

  state.finished = true;
  state.finalReport = outcome.result.finalReport ?? getResultOutput(outcome.result);
  lateReport = state.finalReport;
  suspended = null;
}

export async function answerClarify(text: string, signal?: AbortSignal): Promise<AnswerOutcome> {
  const state = suspended;

  if (!state) {
    const out = lateReport ?? "No child is asking a question.";
    lateReport = null;
    return { kind: "none", text: out };
  }

  if (state.finished) {
    const out = state.finalReport ?? lateReport ?? "The child has already finished.";
    suspended = null;
    lateReport = null;
    return { kind: "none", text: out };
  }

  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  removeAbortListener(state);
  state.budget.delivered++;

  const outcome = await completeClarify(state, text);

  if (outcome.kind === "suspended") {
    state.clarifyId = outcome.clarify.id;
    state.question = outcome.clarify.question;
    startClarifyTimer(state);
    wireAbortDuringSuspend(state, signal);
    return { kind: "ask", question: outcome.clarify.question, result: state.result };
  }

  state.finished = true;
  const report = outcome.result.finalReport ?? getResultOutput(outcome.result);
  const failed = isFailedResult(outcome.result);
  suspended = null;
  lateReport = null;
  return { kind: "done", report, result: outcome.result, failed };
}
