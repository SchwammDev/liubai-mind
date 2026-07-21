import { createHash } from "node:crypto";

export type DedupState = Set<string>;

export function bashKey(command: string): string {
  return "bash\0" + command.trim();
}

export function writeKey(path: string, content: string): string {
  return "write\0" + path + "\0" + sha256(content);
}

export function editKey(
  path: string,
  edits: Array<{ oldText: string; newText: string }>,
): string {
  return "edit\0" + path + "\0" + sha256(JSON.stringify(edits));
}

export function blockReason(toolName: string): string {
  return (
    "[dedup] identical " +
    toolName +
    " already succeeded this session; re-issue blocked. Do not retry the same call. Vary arguments only if this is a genuinely new operation."
  );
}

export function bashMatchesDedup(command: string, patterns: string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern).test(command));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
