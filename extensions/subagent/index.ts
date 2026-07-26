import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { canSpawn, currentDepth, assessQuestion, buildClarifyTitle, QUESTION_CAP } from "./child.ts";
import { DialogGate } from "./bridge.ts";
import { answerClarify, answerToolResult } from "./clarify.ts";
import { runSpawn } from "./orchestrate.ts";
import { spawnRpcTransport } from "./transport.ts";
import { describeCall, describeResult, type ViewNode } from "./view.ts";

type TextNode = Extract<ViewNode, { kind: "text" }>;

const isFlatText = (nodes: ViewNode[]): nodes is TextNode[] => nodes.every((node) => node.kind === "text");

function toWidget(nodes: ViewNode[]): Text | Container {
  if (isFlatText(nodes)) return new Text(nodes.map((node) => node.text).join("\n"), 0, 0);

  const mdTheme = getMarkdownTheme();
  const container = new Container();
  for (const node of nodes) {
    if (node.kind === "spacer") container.addChild(new Spacer(1));
    else if (node.kind === "markdown") container.addChild(new Markdown(node.text, 0, 0, mdTheme));
    else container.addChild(new Text(node.text, 0, 0));
  }
  return container;
}

const COMPLEXITY_DESCRIPTION = [
  "Task difficulty; the extension resolves the child model from it.",
  "Required — in single mode alongside task, and on every item in tasks.",
  "trivial — mechanical, zero judgment: rename, typo, apply stated pattern verbatim.",
  "easy — one obvious change, approach clear before starting, single file/function.",
  "medium — several steps, minor exploration needed, approach settles after a quick look.",
  "hard — design judgment, multi-step debugging, or synthesis across components.",
].join(" ");

const complexityParam = () =>
  Type.Union(
    [Type.Literal("trivial"), Type.Literal("easy"), Type.Literal("medium"), Type.Literal("hard")],
    { description: COMPLEXITY_DESCRIPTION },
  );

const TaskItem = Type.Object({
  task: Type.String({ description: "Task to delegate to the child" }),
  complexity: complexityParam(),
});

const SpawnParams = Type.Object({
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  complexity: Type.Optional(complexityParam()),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {task, complexity} for parallel execution" })),
});

const ClarifyParams = Type.Object({
  question: Type.String({ description: "The single clarifying question to ask the parent model." }),
});

const AnswerParams = Type.Object({
  text: Type.String({ description: "The answer to the child's clarifying question." }),
});

const CLARIFY_DESCRIPTION = [
  "Ask the parent model one clarifying question on genuine ambiguity.",
  "Capped at 2 questions per child; a 3rd is auto-denied.",
  "Use sparingly — needing clarification often signals the task was under-specified; proceed with best judgment when you can.",
  "The question must be under 4096 bytes (UTF-8).",
].join(" ");

function registerClarifyTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "clarify",
    label: "Clarify",
    description: CLARIFY_DESCRIPTION,
    parameters: ClarifyParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const verdict = assessQuestion(params.question);
      if (verdict.kind === "rejected") {
        return {
          content: [{ type: "text", text: `Question is ${verdict.bytes} bytes; re-ask under ${QUESTION_CAP} bytes (UTF-8).` }],
          details: undefined,
          isError: true,
        };
      }

      const answer = await ctx.ui.input(buildClarifyTitle(params.question));
      return {
        content: [{ type: "text", text: answer ?? "proceed with best judgment" }],
        details: undefined,
      };
    },
  });
}

export function register(pi: ExtensionAPI): void {
  if (!canSpawn(currentDepth())) {
    registerClarifyTool(pi);
    return;
  }

  const dialogGate = new DialogGate();

  pi.registerTool({
    name: "spawn",
    label: "Spawn",
    description: [
      "Spawn a child pi process per task with an isolated context window; the child's report lands here.",
      "Modes: single (task) or parallel (tasks array). Provide exactly one.",
    ].join(" "),
    parameters: SpawnParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runSpawn({ spawnTransport: spawnRpcTransport }, ctx, params, signal, onUpdate, dialogGate);
    },

    renderCall(args, theme, _context) {
      return toWidget(describeCall(args, theme));
    },

    renderResult(result, { expanded }, theme, _context) {
      return toWidget(describeResult(result, expanded, theme));
    },
  });

  pi.registerTool({
    name: "answer",
    label: "Answer",
    description: [
      "Reply to a spawned child's clarifying question.",
      "Only meaningful after a spawn suspended with 'Child asks: …'.",
      "Writes the answer to the child and resumes it.",
    ].join(" "),
    parameters: AnswerParams,

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const outcome = await answerClarify(params.text, signal);
      return answerToolResult(outcome);
    },
  });
}

export default register;
