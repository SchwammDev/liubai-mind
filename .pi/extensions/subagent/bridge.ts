import type { Message } from "@earendil-works/pi-ai";

import type { SingleResult } from "./child.ts";

export type Accumulator = Pick<SingleResult, "messages" | "usage" | "stderr" | "model" | "stopReason" | "errorMessage">;

export interface UiForwarder {
  hasUI: boolean;
  confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
  select(title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ChildTransport {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (code: number | null) => void): void;
  kill(): void;
}

export type LineOutcome = { settled: boolean };

export type TurnResult = { settled: boolean; exitCode: number; aborted: boolean };

const DIALOG_METHODS = new Set(["confirm", "select", "input", "editor"]);
const FIRE_AND_FORGET_METHODS = new Set(["setStatus", "setWidget", "setTitle", "set_editor_text"]);

export function processRpcLine(line: string, acc: Accumulator, bridge: AskBridge): LineOutcome {
  if (!line.trim()) return { settled: false };
  let event: any;
  try {
    event = JSON.parse(line);
  } catch {
    return { settled: false };
  }

  if (event.type === "message_end" && event.message) {
    const msg = event.message as Message;
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

  if (event.type === "tool_result_end" && event.message) {
    acc.messages.push(event.message as Message);
    return { settled: false };
  }

  if (event.type === "extension_ui_request") {
    bridge.handle(event).catch(() => {});
    return { settled: false };
  }

  if (event.type === "agent_settled") return { settled: true };

  return { settled: false };
}

export class AskBridge {
  private readonly signal?: AbortSignal;
  private readonly forwarder: UiForwarder;
  private readonly writer: (line: string) => void;

  constructor(forwarder: UiForwarder, writer: (line: string) => void, signal?: AbortSignal) {
    this.forwarder = forwarder;
    this.writer = writer;
    this.signal = signal;
  }

  async handle(req: any): Promise<void> {
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

    const opts = { signal: this.signal };

    try {
      if (req.method === "confirm") {
        const confirmed = await this.forwarder.confirm(req.title, req.message, opts);
        this.writeResponse({ type: "extension_ui_response", id: req.id, confirmed });
        return;
      }
      if (req.method === "select") {
        const value = await this.forwarder.select(req.title, req.options, opts);
        this.writeResponse(
          value === undefined
            ? { type: "extension_ui_response", id: req.id, cancelled: true }
            : { type: "extension_ui_response", id: req.id, value },
        );
        return;
      }
      if (req.method === "input") {
        const value = await this.forwarder.input(req.title, req.placeholder, opts);
        this.writeResponse(
          value === undefined
            ? { type: "extension_ui_response", id: req.id, cancelled: true }
            : { type: "extension_ui_response", id: req.id, value },
        );
        return;
      }
      if (req.method === "editor") {
        const value = await this.forwarder.editor(req.title, req.prefill);
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

  private writeResponse(obj: Record<string, unknown>): void {
    this.writer(JSON.stringify(obj));
  }
}

export class ChildSession {
  private readonly transport: ChildTransport;
  private readonly bridge: AskBridge;
  private readonly onUpdate?: () => void;
  private readonly signal?: AbortSignal;
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
  ) {
    this.transport = transport;
    this.acc = acc;
    this.onUpdate = onUpdate;
    this.signal = signal;
    this.bridge = new AskBridge(forwarder, (line) => transport.write(line), this.dialogController.signal);

    transport.onLine((line) => {
      const out = processRpcLine(line, this.acc, this.bridge);
      this.onUpdate?.();
      if (out.settled && this.resolver) {
        const resolve = this.resolver;
        this.resolver = null;
        resolve({ settled: true, exitCode: 0, aborted: false });
      }
    });

    transport.onClose((code) => {
      this.dialogController.abort();
      if (this.resolver) {
        const resolve = this.resolver;
        this.resolver = null;
        resolve({ settled: false, exitCode: code ?? 1, aborted: this.abortedFlag });
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
      return { settled: false, exitCode: 0, aborted: true };
    }

    this.abortedFlag = false;
    this.transport.write(JSON.stringify({ type: "prompt", message }));

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
