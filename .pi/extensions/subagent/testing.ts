import type { ChildTransport } from "./bridge.ts";

export class FakeTransport implements ChildTransport {
  writes: string[] = [];
  private lineCbs: Array<(line: string) => void> = [];
  private closeCbs: Array<(code: number | null) => void> = [];
  killed = false;

  write(line: string) {
    this.writes.push(line);
  }
  onLine(cb: (line: string) => void) {
    this.lineCbs.push(cb);
  }
  onClose(cb: (code: number | null) => void) {
    this.closeCbs.push(cb);
  }
  kill() {
    this.killed = true;
  }
  emitLine(line: string) {
    for (const cb of this.lineCbs) cb(line);
  }
  emitClose(code: number | null) {
    for (const cb of this.closeCbs) cb(code);
  }
  writtenJson() {
    return this.writes.map((w) => JSON.parse(w));
  }
  lastWrite() {
    const last = this.writes.at(-1);
    return last === undefined ? null : JSON.parse(last);
  }
}
