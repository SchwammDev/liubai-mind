import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { createLineReader, rpcChildCommand, spawnRpcTransport, type Spawner } from "./transport.ts";

const collectingReader = () => {
  const lines: string[] = [];
  const codes: (number | null)[] = [];
  const reader = createLineReader();
  reader.onLine((line) => lines.push(line));
  reader.onClose((code) => codes.push(code));
  return { reader, lines, codes };
};

class FakeStdin extends EventEmitter {
  written: string[] = [];
  write(chunk: string) {
    this.written.push(chunk);
    return true;
  }
}

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = new FakeStdin();
  signals: string[] = [];
  kill(signal: string) {
    this.signals.push(signal);
    return true;
  }
}

const spawnerFor = (proc: FakeProcess): Spawner => () => proc as unknown as ChildProcess;

const attachedTransport = (proc: FakeProcess, killGraceMs = 5000) => {
  const stderr: string[] = [];
  const lines: string[] = [];
  const codes: (number | null)[] = [];
  const transport = spawnRpcTransport("/repo", "some-model", "1", (s) => stderr.push(s), {
    spawner: spawnerFor(proc),
    killGraceMs,
  });
  transport.onLine((line) => lines.push(line));
  transport.onClose((code) => codes.push(code));
  return { transport, stderr, lines, codes };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a partial chunk yields no line until its newline arrives", () => {
  const { reader, lines } = collectingReader();

  reader.push("par");

  assert.deepEqual(lines, []);

  reader.push("tial\n");

  assert.deepEqual(lines, ["partial"]);
});

test("a chunk carrying several newlines yields every complete line", () => {
  const { reader, lines } = collectingReader();

  reader.push("one\ntwo\nthr");

  assert.deepEqual(lines, ["one", "two"]);
});

test("a trailing partial line is delivered before the close is announced", () => {
  const { reader, lines, codes } = collectingReader();
  const order: string[] = [];
  reader.onLine(() => order.push("line"));
  reader.onClose(() => order.push("close"));

  reader.push("tail without newline");
  reader.close(0);

  assert.deepEqual(lines, ["tail without newline"]);
  assert.deepEqual(codes, [0]);
  assert.deepEqual(order, ["line", "close"]);
});

test("a blank trailing buffer is not delivered as a line", () => {
  const { reader, lines } = collectingReader();

  reader.push("done\n   ");
  reader.close(0);

  assert.deepEqual(lines, ["done"]);
});

test("close is announced once even when the stream closes twice", () => {
  const { reader, codes } = collectingReader();

  reader.close(0);
  reader.close(3);

  assert.deepEqual(codes, [0]);
});

test("a child that exits without a code is reported as a failure", () => {
  const { reader, codes } = collectingReader();

  reader.close(null);

  assert.deepEqual(codes, [1]);
});

test("output arriving after the close is dropped", () => {
  const { reader, lines } = collectingReader();

  reader.close(0);
  reader.push("too late\n");

  assert.deepEqual(lines, []);
});

test("the child is invoked in rpc mode on the requested model", () => {
  const { args } = rpcChildCommand("some-model", "1");

  assert.deepEqual(args.slice(-4), ["--mode", "rpc", "--model", "some-model"]);
});

test("the child inherits the parent environment carrying its own spawn depth", () => {
  const { env } = rpcChildCommand("some-model", "2");

  assert.equal(env.LIUBAI_SPAWN_DEPTH, "2");
  assert.equal(env.PATH, process.env.PATH);
});

test("child stdout reaches line subscribers as whole lines", () => {
  const proc = new FakeProcess();
  const { lines } = attachedTransport(proc);

  proc.stdout.emit("data", Buffer.from("first\nsec"));
  proc.stdout.emit("data", Buffer.from("ond\n"));

  assert.deepEqual(lines, ["first", "second"]);
});

test("child stderr is forwarded to the stderr sink", () => {
  const proc = new FakeProcess();
  const { stderr } = attachedTransport(proc);

  proc.stderr.emit("data", Buffer.from("boom"));

  assert.deepEqual(stderr, ["boom"]);
});

test("a written message is terminated so the child can read it as a line", () => {
  const proc = new FakeProcess();
  const { transport } = attachedTransport(proc);

  transport.write('{"type":"prompt"}');

  assert.deepEqual(proc.stdin.written, ['{"type":"prompt"}\n']);
});

test("a child that never starts closes the transport as a failure", () => {
  const proc = new FakeProcess();
  const { codes } = attachedTransport(proc);

  proc.emit("error", new Error("spawn pi ENOENT"));

  assert.deepEqual(codes, [1]);
});

test("stream errors from a dead child do not crash the parent", () => {
  const proc = new FakeProcess();
  attachedTransport(proc);

  assert.doesNotThrow(() => proc.stdin.emit("error", new Error("EPIPE")));
  assert.doesNotThrow(() => proc.stdout.emit("error", new Error("EPIPE")));
  assert.doesNotThrow(() => proc.stderr.emit("error", new Error("EPIPE")));
});

test("a child that ignores the terminate signal is force-killed after the grace period", async () => {
  const proc = new FakeProcess();
  const { transport } = attachedTransport(proc, 1);

  transport.kill();
  await settle();

  assert.deepEqual(proc.signals, ["SIGTERM", "SIGKILL"]);
});

test("a child that exits within the grace period is not force-killed", async () => {
  const proc = new FakeProcess();
  const { transport } = attachedTransport(proc, 1);

  transport.kill();
  proc.emit("close", 0);
  await settle();

  assert.deepEqual(proc.signals, ["SIGTERM"]);
});
