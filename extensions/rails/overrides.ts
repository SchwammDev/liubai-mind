import type {
  AgentToolResult,
  createBashToolDefinition,
  createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  bashKey,
  bashMatchesDedup,
  checkBashEffect,
  consumeApproval,
  duplicateEditInsertion,
  editKey,
  editList,
  effectFamily,
  recordNoop,
  REPLAY_NOTICE,
  type BashResult,
  type DedupLog,
  type DedupSession,
  type EffectCheck,
  type Exec,
  type ReplayEntry,
} from "./dedup.ts";

export type BashTool = ReturnType<typeof createBashToolDefinition>;
export type EditTool = ReturnType<typeof createEditToolDefinition>;

type ResultPart = AgentToolResult<unknown>["content"][number];
type TextPart = Extract<ResultPart, { type: "text" }>;

export type BashDedupDeps = {
  patterns: string[];
  session: DedupSession;
  exec: Exec;
  log: DedupLog;
  enforced: () => boolean;
  disabled: () => boolean;
};

export type EditDedupDeps = {
  session: DedupSession;
  readTargetFile: (path: string) => Promise<string>;
  log: DedupLog;
  enforced: () => boolean;
  disabled: () => boolean;
};

export function withBashDedup<T extends Pick<BashTool, "name" | "execute">>(
  delegate: T,
  deps: BashDedupDeps,
): T {
  return {
    ...delegate,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const passthrough = () => delegate.execute(toolCallId, params, signal, onUpdate, ctx);
      if (deps.disabled()) return passthrough();
      const command = String(params?.command ?? "");
      if (!bashMatchesDedup(command, deps.patterns)) return passthrough();

      const key = bashKey(command);
      // pi signals a failed command by throwing, so a rejected passthrough never
      // reaches the cache; that rejection is the whole guard against replaying a
      // failure as a completed run.
      const runFresh = async (cacheReplay: boolean) => {
        const result = await passthrough();
        if (cacheReplay) rememberForReplay(deps.session, key, result);
        return result;
      };
      if (consumeApproval(deps.session, key)) return runFresh(effectFamily(command) === null);

      const check = await checkBashEffect(command, deps.exec);
      const deduped = dedupedBashResult(deps, command, key, check);
      return deduped ?? runFresh(check.effect === "unqueryable");
    },
  };
}

function dedupedBashResult(
  deps: BashDedupDeps,
  command: string,
  key: string,
  check: EffectCheck,
): BashResult | null {
  const enforced = deps.enforced();
  if (check.effect === "present") return presentEffectResult(deps, command, key, check.notice, enforced);
  if (check.effect === "unqueryable") return unqueryableEffectResult(deps, command, key, enforced);
  if (check.effect === "unparseable") {
    deps.log({ kind: "parse-miss", tool: "bash", command, action: "executed" });
  }
  return null;
}

function presentEffectResult(
  deps: BashDedupDeps,
  command: string,
  key: string,
  notice: string,
  enforced: boolean,
): BashResult | null {
  deps.log({
    kind: enforced ? "noop" : "would-dedup",
    tool: "bash",
    command,
    action: enforced ? "noop" : "executed",
  });
  if (!enforced) return null;
  recordNoop(deps.session, key);
  return noopResult(notice);
}

function unqueryableEffectResult(
  deps: BashDedupDeps,
  command: string,
  key: string,
  enforced: boolean,
): BashResult | null {
  const cached = deps.session.replayCache.get(key);
  if (!cached) return null;
  deps.log({
    kind: enforced ? "replay" : "would-dedup",
    tool: "bash",
    command,
    action: enforced ? "replayed" : "executed",
  });
  if (!enforced) return null;
  recordNoop(deps.session, key);
  return replayedResult(cached);
}

export function withEditDedup<T extends Pick<EditTool, "name" | "execute">>(
  delegate: T,
  deps: EditDedupDeps,
): T {
  return {
    ...delegate,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const passthrough = () => delegate.execute(toolCallId, params, signal, onUpdate, ctx);
      if (deps.disabled()) return passthrough();

      const edits = editList(params);
      const key = editKey(params.path, edits);
      if (consumeApproval(deps.session, key)) return passthrough();

      const content = await deps.readTargetFile(params.path).catch(() => null);
      const duplicate = content === null ? null : duplicateEditInsertion(content, edits);
      if (duplicate) {
        const result = duplicateEditResult(deps, key, params.path, duplicate.line);
        if (result) return result;
      }
      return passthrough();
    },
  };
}

function duplicateEditResult(
  deps: EditDedupDeps,
  key: string,
  path: string,
  line: number,
): BashResult | null {
  const enforced = deps.enforced();
  deps.log({
    kind: enforced ? "noop" : "would-dedup",
    tool: "edit",
    key,
    action: enforced ? "noop" : "executed",
  });
  if (!enforced) return null;
  recordNoop(deps.session, key);
  return noopResult(`content already present at ${path}:${line}`);
}

function noopResult(notice: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: `[dedup] ${notice}` }], details: undefined };
}

function rememberForReplay(session: DedupSession, key: string, result: BashResult): void {
  try {
    session.replayCache.set(key, snapshot(result));
  } catch {
    // A result that cannot be cloned is merely unreplayable; caching must never
    // turn a command that already ran into a reported failure.
  }
}

function snapshot(result: BashResult): ReplayEntry {
  return structuredClone({ content: result.content ?? [], details: result.details });
}

function replayedResult(entry: ReplayEntry): BashResult {
  const content: ResultPart[] = structuredClone(entry.content);
  const first = content.find(isTextPart);
  if (first) first.text = `${REPLAY_NOTICE}\n\n${first.text}`;
  else content.unshift({ type: "text", text: REPLAY_NOTICE });
  return { content, details: structuredClone(entry.details) };
}

function isTextPart(part: ResultPart): part is TextPart {
  return part.type === "text";
}
