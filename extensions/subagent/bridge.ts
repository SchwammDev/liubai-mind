import type {
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";

import { CLARIFY_TAG, MAX_CLARIFY, type SingleResult } from "./child.ts";

export type Accumulator = Pick<SingleResult, "messages" | "usage" | "stderr" | "model" | "stopReason" | "errorMessage">;

export type DialogOptions = { signal?: AbortSignal | undefined; timeout?: number | undefined };

export interface UiForwarder {
  hasUI: boolean;
  confirm(title: string, message: string, opts?: DialogOptions): Promise<boolean>;
  select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ChildTransport {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (code: number | null) => void): void;
  kill(): void;
}

export type ClarifyIntercept =
  | { kind: "suspend"; clarifyId: string; question: string }
  | { kind: "denied" }
  | { kind: "pass" };

export type LineOutcome = { settled: boolean; suspended?: { clarifyId: string; question: string } };

export type TurnResult = {
  settled: boolean;
  suspended: boolean;
  exitCode: number;
  aborted: boolean;
  clarify?: { id: string; question: string };
};

const DIALOG_METHODS = new Set(["confirm", "select", "input", "editor"]);
const FIRE_AND_FORGET_METHODS = new Set(["setStatus", "setWidget", "setTitle", "set_editor_text"]);
const MESSAGE_ROLES = new Set(["user", "assistant", "toolResult"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMessage(value: unknown): value is Message {
  return isRecord(value) && typeof value.role === "string" && MESSAGE_ROLES.has(value.role);
}

// The child is a pi process, so every request that names a method we act on
// carries that method's payload; anything else is dropped rather than trusted.
function isUiRequest(value: unknown): value is RpcExtensionUIRequest {
  if (!isRecord(value) || value.type !== "extension_ui_request") return false;
  if (typeof value.id !== "string" || typeof value.method !== "string") return false;
  if (value.method === "notify") return typeof value.message === "string";
  if (DIALOG_METHODS.has(value.method)) return typeof value.title === "string";
  return FIRE_AND_FORGET_METHODS.has(value.method);
}

export function processRpcLine(line: string, acc: Accumulator, bridge: AskBridge): LineOutcome {
  if (!line.trim()) return { settled: false };
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { settled: false };
  }
  if (!isRecord(event)) return { settled: false };

  if (event.type === "message_end" && isMessage(event.message)) {
    const msg = event.message;
    acc.messages.push(msg);
    if (msg.role === "assistant") {
      acc.usage.turns++;
      const usage = msg.usage;
      if (usage) {
        acc.usage.input += usage.input || 0;
        acc.usage.output += usage.output || 0;
        acc.usage.cacheRead += usage.cacheRead || 0;
        acc.usage.cacheWrite += usage.cacheWrite || 0;
        acc.usage.cost += usage.cost?.total || 0;
        acc.usage.contextTokens = usage.totalTokens || 0;
      }
      if (!acc.model && msg.model) acc.model = msg.model;
      if (msg.stopReason) acc.stopReason = msg.stopReason;
      if (msg.errorMessage) acc.errorMessage = msg.errorMessage;
    }
    return { settled: false };
  }

  if (isUiRequest(event)) {
    const intercept = bridge.interceptClarify(event);
    if (intercept.kind === "suspend") return { settled: false, suspended: { clarifyId: intercept.clarifyId, question: intercept.question } };
    if (intercept.kind === "denied") return { settled: false };
    bridge.handle(event).catch(() => {});
    return { settled: false };
  }

  if (event.type === "agent_settled") return { settled: true };

  return { settled: false };
}

// The parent TUI shows one extension dialog at a time; a second concurrent
// dialog silently replaces the first and its promise never resolves. Chaining
// every dialog through a shared gate keeps parallel children's asks queued.
export class DialogGate {
  private chain: Promise<unknown> = Promise.resolve();

  enqueue<T>(skipValue: T, signal: AbortSignal | undefined, show: () => Promise<T>): Promise<T> {
    const turn = this.chain.then(() => (signal?.aborted ? skipValue : show()));
    this.chain = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }
}

export class AskBridge {
  private readonly signal: AbortSignal | undefined;
  private readonly forwarder: UiForwarder;
  private readonly writer: (line: string) => void;
  private readonly gate: DialogGate;

  private readonly mode: "single" | "parallel";
  private readonly budget: { delivered: number };
  private clarifyInFlight = false;

  constructor(
    forwarder: UiForwarder,
    writer: (line: string) => void,
    signal?: AbortSignal,
    gate?: DialogGate,
    mode: "single" | "parallel" = "single",
    budget: { delivered: number } = { delivered: 0 },
  ) {
    this.forwarder = forwarder;
    this.writer = writer;
    this.signal = signal;
    this.gate = gate ?? new DialogGate();
    this.mode = mode;
    this.budget = budget;
  }

  interceptClarify(req: RpcExtensionUIRequest): ClarifyIntercept {
    if (req.method !== "input" || typeof req.title !== "string" || !req.title.startsWith(CLARIFY_TAG)) return { kind: "pass" };
    const question = req.title.slice(CLARIFY_TAG.length);
    // A second clarify while one is already suspended is a duplicate tool call
    // (reasoning models sometimes re-emit the call after a thinking block); the
    // parent has a single suspend slot, so auto-deny instead of dropping it and
    // hanging the child turn on a response nobody will give.
    if (this.mode === "parallel" || this.budget.delivered >= MAX_CLARIFY || this.clarifyInFlight) {
      this.writeResponse({ type: "extension_ui_response", id: req.id, value: "proceed with best judgment" });
      return { kind: "denied" };
    }
    this.clarifyInFlight = true;
    return { kind: "suspend", clarifyId: req.id, question };
  }

  clearClarifyInFlight(): void {
    this.clarifyInFlight = false;
  }

  async handle(req: RpcExtensionUIRequest): Promise<void> {
    if (req.method === "notify") {
      this.forwarder.notify(req.message, req.notifyType);
      return;
    }

    if (FIRE_AND_FORGET_METHODS.has(req.method)) return;

    if (!DIALOG_METHODS.has(req.method)) return;

    if (!this.forwarder.hasUI) {
      this.writeResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
      return;
    }

    const opts: DialogOptions = {
      signal: this.signal,
      timeout: "timeout" in req ? req.timeout : undefined,
    };

    try {
      if (req.method === "confirm") {
        const confirmed = await this.gate.enqueue(false, this.signal, () =>
          this.forwarder.confirm(req.title, req.message, opts),
        );
        this.writeResponse({ type: "extension_ui_response", id: req.id, confirmed });
        return;
      }
      if (req.method === "select") {
        const value = await this.gate.enqueue<string | undefined>(undefined, this.signal, () =>
          this.forwarder.select(req.title, req.options, opts),
        );
        this.writeResponse(
          value === undefined
            ? { type: "extension_ui_response", id: req.id, cancelled: true }
            : { type: "extension_ui_response", id: req.id, value },
        );
        return;
      }
      if (req.method === "input") {
        const value = await this.gate.enqueue<string | undefined>(undefined, this.signal, () =>
          this.forwarder.input(req.title, req.placeholder, opts),
        );
        this.writeResponse(
          value === undefined
            ? { type: "extension_ui_response", id: req.id, cancelled: true }
            : { type: "extension_ui_response", id: req.id, value },
        );
        return;
      }
      if (req.method === "editor") {
        const value = await this.gate.enqueue<string | undefined>(undefined, this.signal, () =>
          this.forwarder.editor(req.title, req.prefill),
        );
        this.writeResponse(
          value === undefined
            ? { type: "extension_ui_response", id: req.id, cancelled: true }
            : { type: "extension_ui_response", id: req.id, value },
        );
        return;
      }
    } catch {
      this.writeResponse({ type: "extension_ui_response", id: req.id, cancelled: true });
    }
  }

  private writeResponse(response: RpcExtensionUIResponse): void {
    this.writer(JSON.stringify(response));
  }
}

export class ChildSession {
  private readonly transport: ChildTransport;
  private readonly bridge: AskBridge;
  private readonly onUpdate: (() => void) | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly acc: Accumulator;
  private readonly dialogController = new AbortController();
  private resolver: ((result: TurnResult) => void) | null = null;
  private abortedFlag = false;
  private abortHandler: (() => void) | null = null;

  constructor(
    transport: ChildTransport,
    forwarder: UiForwarder,
    acc: Accumulator,
    onUpdate?: () => void,
    signal?: AbortSignal,
    gate?: DialogGate,
    mode: "single" | "parallel" = "single",
    budget: { delivered: number } = { delivered: 0 },
  ) {
    this.transport = transport;
    this.acc = acc;
    this.onUpdate = onUpdate;
    this.signal = signal;
    this.bridge = new AskBridge(
      forwarder,
      (line) => transport.write(line),
      this.dialogController.signal,
      gate,
      mode,
      budget,
    );

    transport.onLine((line) => {
      const out = processRpcLine(line, this.acc, this.bridge);
      this.onUpdate?.();
      if (out.suspended && this.resolver) {
        const resolve = this.resolver;
        this.resolver = null;
        resolve({
          settled: false,
          suspended: true,
          exitCode: 0,
          aborted: false,
          clarify: { id: out.suspended.clarifyId, question: out.suspended.question },
        });
        return;
      }
      if (out.settled && this.resolver) {
        const resolve = this.resolver;
        this.resolver = null;
        resolve({ settled: true, suspended: false, exitCode: 0, aborted: false });
      }
    });

    transport.onClose((code) => {
      this.dialogController.abort();
      if (this.resolver) {
        const resolve = this.resolver;
        this.resolver = null;
        resolve({ settled: false, suspended: false, exitCode: code ?? 1, aborted: this.abortedFlag });
      }
    });

    if (signal) {
      this.abortHandler = () => {
        this.abortedFlag = true;
        this.dialogController.abort();
        this.transport.kill();
      };
      signal.addEventListener("abort", this.abortHandler, { once: true });
    }
  }

  async sendPrompt(message: string): Promise<TurnResult> {
    if (this.signal?.aborted) {
      this.transport.kill();
      return { settled: false, suspended: false, exitCode: 0, aborted: true };
    }

    this.abortedFlag = false;
    this.transport.write(JSON.stringify({ type: "prompt", message }));

    return this.awaitSettlement();
  }

  async resume(): Promise<TurnResult> {
    this.bridge.clearClarifyInFlight();
    return this.awaitSettlement();
  }

  private async awaitSettlement(): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      this.resolver = resolve;
    });
  }

  close(): void {
    if (this.abortHandler && this.signal) {
      this.signal.removeEventListener("abort", this.abortHandler);
    }
    this.dialogController.abort();
    this.transport.kill();
  }
}
