import { test } from "node:test";
import assert from "node:assert/strict";

import { transcriptIsContaminated } from "./contamination.ts";

const REPO_ROOT = "/home/user/code/liubai-mind";
const HARNESS_PATH_PREFIXES = [REPO_ROOT, "/.pi/", "~/.pi"];

function assistantToolCallLine(name: string, args: unknown): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-1", name, arguments: args }],
    },
  });
}

function toolResultLine(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: { role: "toolResult", content: [{ type: "text", text }] },
  });
}

function transcript(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

test("clean_transcript_with_no_harness_path_reference_is_not_contaminated", () => {
  const jsonl = transcript(assistantToolCallLine("bash", { command: "ls /tmp/eval-work-abc" }));

  const contaminated = transcriptIsContaminated(jsonl, HARNESS_PATH_PREFIXES);

  assert.equal(contaminated, false);
});

test("bash_command_reading_a_path_under_the_repo_root_is_contaminated", () => {
  const jsonl = transcript(
    assistantToolCallLine("bash", { command: `cat ${REPO_ROOT}/engine/eval/corpus/ts-flag-parser/parse_flags.ts` }),
  );

  const contaminated = transcriptIsContaminated(jsonl, HARNESS_PATH_PREFIXES);

  assert.equal(contaminated, true);
});

test("tool_call_touching_the_pi_agent_home_directory_is_contaminated", () => {
  const jsonl = transcript(assistantToolCallLine("read", { path: "~/.pi/agent/config.json" }));

  const contaminated = transcriptIsContaminated(jsonl, HARNESS_PATH_PREFIXES);

  assert.equal(contaminated, true);
});

test("dotpi_directory_reached_via_an_absolute_path_is_contaminated", () => {
  const jsonl = transcript(assistantToolCallLine("bash", { command: "find /home/user/.pi/agent -name '*.json'" }));

  const contaminated = transcriptIsContaminated(jsonl, HARNESS_PATH_PREFIXES);

  assert.equal(contaminated, true);
});

test("harness_path_appearing_only_in_a_tool_result_is_not_flagged", () => {
  const jsonl = transcript(
    assistantToolCallLine("bash", { command: "ls /tmp/eval-work-abc" }),
    toolResultLine(`${REPO_ROOT}/engine/eval/corpus/ts-flag-parser/parse_flags.ts`),
  );

  const contaminated = transcriptIsContaminated(jsonl, HARNESS_PATH_PREFIXES);

  assert.equal(contaminated, false);
});

test("harness_path_nested_inside_an_edit_tool_calls_arguments_is_detected", () => {
  const edits = [{ oldText: "old", newText: `see ${REPO_ROOT}/engine/eval/score.ts for reference` }];
  const jsonl = transcript(assistantToolCallLine("edit", { path: "/tmp/eval-work-abc/parse_flags.ts", edits }));

  const contaminated = transcriptIsContaminated(jsonl, HARNESS_PATH_PREFIXES);

  assert.equal(contaminated, true);
});

test("blank_and_malformed_lines_are_ignored_without_throwing", () => {
  const jsonl = ["", "not json", assistantToolCallLine("bash", { command: "echo hi" })].join("\n") + "\n";

  const contaminated = transcriptIsContaminated(jsonl, HARNESS_PATH_PREFIXES);

  assert.equal(contaminated, false);
});
