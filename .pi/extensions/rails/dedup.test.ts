import { test } from "node:test";
import assert from "node:assert/strict";

import {
  approveRerun,
  bashKey,
  bashMatchesDedup,
  checkBashEffect,
  consumeApproval,
  createSession,
  duplicateEditInsertion,
  editKey,
  recordNoop,
  repeatedDuplicate,
  type Exec,
} from "./dedup.ts";

const COMMENT_URL = "https://github.com/o/r/issues/5#issuecomment-1";

function ghExec(payloads: Record<string, unknown>): Exec {
  return async (argv) => {
    const field = argv[argv.indexOf("--json") + 1];
    if (field in payloads) return { stdout: JSON.stringify(payloads[field]), exitCode: 0 };
    return { stdout: "", exitCode: 1 };
  };
}

function gitExec(shaByRev: Record<string, string>): Exec {
  return async (argv) => {
    const rev = argv[argv.length - 1];
    const sha = shaByRev[rev];
    return sha ? { stdout: sha + "\n", exitCode: 0 } : { stdout: "", exitCode: 1 };
  };
}

const failingExec: Exec = async () => ({ stdout: "", exitCode: 1 });

test("bashKey is equal for commands differing only by surrounding whitespace", () => {
  assert.equal(bashKey("  gh issue comment 8  "), bashKey("gh issue comment 8"));
});

test("editKey differs when the edits differ", () => {
  const e1 = [{ oldText: "a", newText: "b" }];
  const e2 = [{ oldText: "a", newText: "c" }];

  assert.notEqual(editKey("a.txt", e1), editKey("a.txt", e2));
});

test("bashMatchesDedup respects regex word boundaries", () => {
  const patterns = ["\\bgh\\s+(issue|pr)\\s+comment\\b"];

  assert.equal(bashMatchesDedup("gh issue comment 8 --body x", patterns), true);
  assert.equal(bashMatchesDedup("gh issue view 8", patterns), false);
});

test("a gh comment whose body already exists reports the existing comment URL", async () => {
  const exec = ghExec({ comments: { comments: [{ body: "Fix  Confirmed, thanks!", url: COMMENT_URL }] } });

  const check = await checkBashEffect('gh issue comment 5 --body "fix confirmed, thanks!"', exec);

  assert.equal(check.effect, "present");
  assert.match((check as any).notice, new RegExp(COMMENT_URL));
});

test("a gh comment with an unposted body has no matching effect", async () => {
  const exec = ghExec({ comments: { comments: [{ body: "old note", url: COMMENT_URL }] } });

  const check = await checkBashEffect("gh issue comment 5 --body 'brand new'", exec);

  assert.equal(check.effect, "absent");
});

test("a gh comment read from a body file is a parse miss", async () => {
  const check = await checkBashEffect("gh issue comment 5 --body-file notes.md", failingExec);

  assert.equal(check.effect, "unparseable");
});

test("a compound command is a parse miss", async () => {
  const check = await checkBashEffect("gh issue comment 5 -b hi && echo done", failingExec);

  assert.equal(check.effect, "unparseable");
});

test("closing an already closed issue is already effected", async () => {
  const exec = ghExec({ state: { state: "CLOSED" } });

  const check = await checkBashEffect("gh issue close 5", exec);

  assert.equal(check.effect, "present");
  assert.match((check as any).notice, /already closed/);
});

test("closing an open issue is not yet effected", async () => {
  const exec = ghExec({ state: { state: "OPEN" } });

  const check = await checkBashEffect("gh issue close 5", exec);

  assert.equal(check.effect, "absent");
});

test("reopening an open issue is already effected", async () => {
  const exec = ghExec({ state: { state: "OPEN" } });

  const check = await checkBashEffect("gh issue reopen 5", exec);

  assert.equal(check.effect, "present");
});

test("a git tag already at HEAD is already effected", async () => {
  const exec = gitExec({ "refs/tags/v1^{commit}": "abc123", HEAD: "abc123" });

  const check = await checkBashEffect("git tag v1", exec);

  assert.equal(check.effect, "present");
  assert.match((check as any).notice, /v1/);
});

test("a git tag at another commit executes so git can report the real conflict", async () => {
  const exec = gitExec({ "refs/tags/v1^{commit}": "abc123", HEAD: "def456" });

  const check = await checkBashEffect("git tag v1", exec);

  assert.equal(check.effect, "absent");
});

test("an unknown git tag is not yet effected", async () => {
  const exec = gitExec({ HEAD: "abc123" });

  const check = await checkBashEffect("git tag v1", exec);

  assert.equal(check.effect, "absent");
});

test("a curl POST has no queryable effect state", async () => {
  const check = await checkBashEffect("curl -X POST https://api.example.com/x", failingExec);

  assert.equal(check.effect, "unqueryable");
});

test("a failing gh view falls open to normal execution", async () => {
  const check = await checkBashEffect("gh issue comment 5 --body hi", failingExec);

  assert.equal(check.effect, "absent");
});

const FILE = ["# Title", "", "alpha one", "beta two", "gamma three", "", "tail"].join("\n");

test("an insertion whose lines already sit consecutively in the file reports their line", () => {
  const edits = [{ oldText: "# Title", newText: "# Title\nalpha one\nbeta two\ngamma three" }];

  const dup = duplicateEditInsertion(FILE, edits);

  assert.deepEqual(dup, { line: 3 });
});

test("fewer than three non-blank re-added lines do not count as a duplicate", () => {
  const edits = [{ oldText: "# Title", newText: "# Title\nalpha one\nbeta two" }];

  assert.equal(duplicateEditInsertion(FILE, edits), null);
});

test("lines relocated from oldText are not treated as re-added", () => {
  const edits = [
    { oldText: "alpha one\nbeta two\ngamma three", newText: "gamma three\nalpha one\nbeta two" },
  ];

  assert.equal(duplicateEditInsertion(FILE, edits), null);
});

test("an insertion of content absent from the file is no duplicate", () => {
  const edits = [{ oldText: "# Title", newText: "# Title\nnew one\nnew two\nnew three" }];

  assert.equal(duplicateEditInsertion(FILE, edits), null);
});

test("a key noopped once counts as a repeated duplicate", () => {
  const session = createSession();
  const key = bashKey("npm publish");

  recordNoop(session, key);

  assert.equal(repeatedDuplicate(session, key), true);
});

test("an approval is consumed exactly once and clears the duplicate counter", () => {
  const session = createSession();
  const key = bashKey("npm publish");
  recordNoop(session, key);
  approveRerun(session, key);

  assert.equal(repeatedDuplicate(session, key), false);
  assert.equal(consumeApproval(session, key), true);
  assert.equal(consumeApproval(session, key), false);
  assert.equal(repeatedDuplicate(session, key), false);
});
