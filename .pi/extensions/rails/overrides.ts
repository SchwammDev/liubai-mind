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
  type DedupLog,
  type DedupSession,
  type Exec,
  type ReplayEntry,
} from "./dedup.ts";

export type ToolLike = { name: string; execute: (...args: any[]) => Promise<any> } & Record<
  string,
  unknown
>;

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

export function withBashDedup(delegate: ToolLike, deps: BashDedupDeps): ToolLike {
  return {
    ...delegate,
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const passthrough = () => delegate.execute(toolCallId, params, signal, onUpdate, ctx);
      if (deps.disabled()) return passthrough();
      const command = String(params?.command ?? "");
      if (!bashMatchesDedup(command, deps.patterns)) return passthrough();

      const key = bashKey(command);
      const runFresh = async (cacheReplay: boolean) => {
        const result = await passthrough();
        if (!result?.isError && cacheReplay) {
          deps.session.replayCache.set(key, snapshot(result));
        }
        return result;
      };
      if (consumeApproval(deps.session, key)) return runFresh(effectFamily(command) === null);

      const check = await checkBashEffect(command, deps.exec);
      const enforced = deps.enforced();
      if (check.effect === "present") {
        deps.log({
          kind: enforced ? "noop" : "would-dedup",
          tool: "bash",
          command,
          action: enforced ? "noop" : "executed",
        });
        if (enforced) {
          recordNoop(deps.session, key);
          return noopResult(check.notice);
        }
      }
      if (check.effect === "unqueryable") {
        const cached = deps.session.replayCache.get(key);
        if (cached) {
          deps.log({
            kind: enforced ? "replay" : "would-dedup",
            tool: "bash",
            command,
            action: enforced ? "replayed" : "executed",
          });
          if (enforced) {
            recordNoop(deps.session, key);
            return replayedResult(cached);
          }
        }
        return runFresh(true);
      }
      if (check.effect === "unparseable") {
        deps.log({ kind: "parse-miss", tool: "bash", command, action: "executed" });
      }
      return runFresh(false);
    },
  };
}

export function withEditDedup(delegate: ToolLike, deps: EditDedupDeps): ToolLike {
  return {
    ...delegate,
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const passthrough = () => delegate.execute(toolCallId, params, signal, onUpdate, ctx);
      if (deps.disabled()) return passthrough();

      const edits = editList(params);
      const key = editKey(params.path, edits);
      if (consumeApproval(deps.session, key)) return passthrough();

      const content = await deps.readTargetFile(params.path).catch(() => null);
      const duplicate = content === null ? null : duplicateEditInsertion(content, edits);
      if (duplicate) {
        const enforced = deps.enforced();
        deps.log({
          kind: enforced ? "noop" : "would-dedup",
          tool: "edit",
          key,
          action: enforced ? "noop" : "executed",
        });
        if (enforced) {
          recordNoop(deps.session, key);
          return noopResult(`content already present at ${params.path}:${duplicate.line}`);
        }
      }
      return passthrough();
    },
  };
}

function noopResult(notice: string) {
  return { content: [{ type: "text", text: `[dedup] ${notice}` }], details: undefined };
}

function snapshot(result: any): ReplayEntry {
  return structuredClone({ content: result.content ?? [], details: result.details });
}

function replayedResult(entry: ReplayEntry) {
  const content: any[] = structuredClone(entry.content);
  const first = content.find((part) => part?.type === "text");
  if (first) first.text = `${REPLAY_NOTICE}\n\n${first.text}`;
  else content.unshift({ type: "text", text: REPLAY_NOTICE });
  return { content, details: structuredClone(entry.details) };
}
