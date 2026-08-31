import { test } from "node:test";
import assert from "node:assert/strict";

import { transcriptIsContaminated, classifyTranscript } from "./contamination.ts";

const REPO_ROOT = "/home/user/code/liubai-mind";
const ANSWER_KEY_PREFIXES = [`${REPO_ROOT}/engine/eval`, ".pi/agent/engine/eval"];
const RAIL_PATH_PREFIXES = [REPO_ROOT, "/.pi/", "~/.pi"];

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

function classify(jsonl: string) {
  return classifyTranscript(jsonl, { answerKeyPrefixes: ANSWER_KEY_PREFIXES, railPrefixes: RAIL_PATH_PREFIXES });
}

test("clean_transcript_with_no_harness_path_reference_is_not_contaminated", () => {
  const jsonl = transcript(assistantToolCallLine("bash", { command: "ls /tmp/eval-work-abc" }));

  const contaminated = transcriptIsContaminated(jsonl, ANSWER_KEY_PREFIXES);

  assert.equal(contaminated, false);
});

test("clean_transcript_neither_touches_the_answer_key_nor_consults_the_rail", () => {
  const jsonl = transcript(assistantToolCallLine("bash", { command: "ls /tmp/eval-work-abc" }));

  assert.deepEqual(classify(jsonl), { contaminated: false, consultedRail: false });
});

test("bash_command_reading_a_path_under_the_answer_key_directory_is_contaminated", () => {
  const jsonl = transcript(
    assistantToolCallLine("bash", { command: `cat ${REPO_ROOT}/engine/eval/corpus/ts-flag-parser/parse_flags.ts` }),
  );

  const contaminated = transcriptIsContaminated(jsonl, ANSWER_KEY_PREFIXES);

  assert.equal(contaminated, true);
});

test("transcript_referencing_the_answer_key_directory_is_contaminated_and_not_a_rail_consult", () => {
  const jsonl = transcript(
    assistantToolCallLine("bash", { command: `cat ${REPO_ROOT}/engine/eval/corpus/ts-flag-parser/parse_flags.ts` }),
  );

  assert.deepEqual(classify(jsonl), { contaminated: true, consultedRail: false });
});

test("harness_path_nested_inside_an_edit_tool_calls_arguments_is_detected", () => {
  const edits = [{ oldText: "old", newText: `see ${REPO_ROOT}/engine/eval/score.ts for reference` }];
  const jsonl = transcript(assistantToolCallLine("edit", { path: "/tmp/eval-work-abc/parse_flags.ts", edits }));

  const contaminated = transcriptIsContaminated(jsonl, ANSWER_KEY_PREFIXES);

  assert.equal(contaminated, true);
});

test("harness_path_appearing_only_in_a_tool_result_is_not_flagged", () => {
  const jsonl = transcript(
    assistantToolCallLine("bash", { command: "ls /tmp/eval-work-abc" }),
    toolResultLine(`${REPO_ROOT}/engine/eval/corpus/ts-flag-parser/parse_flags.ts`),
  );

  const contaminated = transcriptIsContaminated(jsonl, ANSWER_KEY_PREFIXES);

  assert.equal(contaminated, false);
});

test("tool_call_touching_the_pi_agent_home_directory_is_a_rail_consult_not_contamination", () => {
  const jsonl = transcript(assistantToolCallLine("read", { path: "~/.pi/agent/config.json" }));

  assert.deepEqual(classify(jsonl), { contaminated: false, consultedRail: true });
});

test("dotpi_directory_reached_via_an_absolute_path_is_a_rail_consult_not_contamination", () => {
  const jsonl = transcript(assistantToolCallLine("bash", { command: "find /home/user/.pi/agent -name '*.json'" }));

  assert.deepEqual(classify(jsonl), { contaminated: false, consultedRail: true });
});

test("reading_a_rail_file_under_the_repo_root_outside_the_answer_key_is_a_rail_consult", () => {
  const jsonl = transcript(assistantToolCallLine("read", { path: `${REPO_ROOT}/engine/policy.ts` }));

  assert.deepEqual(classify(jsonl), { contaminated: false, consultedRail: true });
});

test("reading_the_pi_agent_extensions_directory_is_a_rail_consult", () => {
  const jsonl = transcript(assistantToolCallLine("read", { path: "~/.pi/agent/extensions/rails/index.ts" }));

  assert.deepEqual(classify(jsonl), { contaminated: false, consultedRail: true });
});

test("blank_and_malformed_lines_are_ignored_without_throwing", () => {
  const jsonl = ["", "not json", assistantToolCallLine("bash", { command: "echo hi" })].join("\n") + "\n";

  const contaminated = transcriptIsContaminated(jsonl, ANSWER_KEY_PREFIXES);

  assert.equal(contaminated, false);
});
