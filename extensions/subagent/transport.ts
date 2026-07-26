import { spawn, type ChildProcess } from "node:child_process";

import type { ChildTransport } from "./bridge.ts";
import { getPiInvocation } from "./child.ts";

const KILL_GRACE_MS = 5000;

export interface LineReader {
  push(chunk: string): void;
  close(code: number | null): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (code: number | null) => void): void;
  isClosed(): boolean;
}

// A child that dies without an exit code failed; the rpc protocol is
// line-delimited, so a trailing fragment is still a message worth delivering.
export function createLineReader(): LineReader {
  let buffer = "";
  let closed = false;
  const lineCbs: ((line: string) => void)[] = [];
  const closeCbs: ((code: number | null) => void)[] = [];

  const emitLine = (line: string) => {
    for (const cb of lineCbs) cb(line);
  };

  return {
    push(chunk) {
      if (closed) return;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) emitLine(line);
    },

    close(code) {
      if (closed) return;
      closed = true;
      if (buffer.trim()) emitLine(buffer);
      buffer = "";
      for (const cb of closeCbs) cb(code ?? 1);
    },

    onLine(cb) {
      lineCbs.push(cb);
    },

    onClose(cb) {
      closeCbs.push(cb);
    },

    isClosed() {
      return closed;
    },
  };
}

export function rpcChildCommand(
  model: string,
  depthEnv: string,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const invocation = getPiInvocation(["--mode", "rpc", "--model", model]);
  return {
    command: invocation.command,
    args: invocation.args,
    env: { ...process.env, LIUBAI_SPAWN_DEPTH: depthEnv },
  };
}

export type Spawner = (cwd: string, model: string, depthEnv: string) => ChildProcess;

const spawnPi: Spawner = (cwd, model, depthEnv) => {
  const { command, args, env } = rpcChildCommand(model, depthEnv);
  return spawn(command, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env });
};

export function spawnRpcTransport(
  cwd: string,
  model: string,
  depthEnv: string,
  onStderr: (data: string) => void,
  deps: { spawner?: Spawner; killGraceMs?: number } = {},
): ChildTransport {
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const proc = (deps.spawner ?? spawnPi)(cwd, model, depthEnv);
  const reader = createLineReader();

  proc.stdout?.on("data", (data: Buffer) => reader.push(data.toString()));
  proc.stderr?.on("data", (data: Buffer) => onStderr(data.toString()));

  // A dead child's streams reject with EPIPE (a late extension_ui_response after
  // the child exited); swallow it so the parent doesn't crash. proc 'error'
  // covers spawn failure (binary not found), which reads as a failed exit.
  proc.stdin?.on("error", () => {});
  proc.stdout?.on("error", () => {});
  proc.stderr?.on("error", () => {});
  proc.on("error", () => reader.close(1));
  proc.on("close", (code) => reader.close(code));

  return {
    write: (line: string) => {
      proc.stdin?.write(line + "\n");
    },
    onLine: (cb) => reader.onLine(cb),
    onClose: (cb) => reader.onClose(cb),
    kill: () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!reader.isClosed()) proc.kill("SIGKILL");
      }, killGraceMs);
    },
  };
}
