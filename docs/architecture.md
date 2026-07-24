# Architecture

Dev-facing. How the steering layer is built and extended.

## Substrate

Engine = pi (`@earendil-works/pi-coding-agent`), pinned and vendored via npm. The contribution is the steering layer on top; pi ships the editor, the hooks, the runtime. See [`landscape.md`](landscape.md) for why pi over alternatives.

## Rails extension

`.pi/extensions/rails/` — one pi extension (`index.ts`), loaded globally by `setup.sh` into `~/.pi/agent/extensions/rails`:

| Event / tool | Handler | Does |
|---|---|---|
| `bash`, `edit` (tool override) | `overrides.ts` + `dedup.ts` | effect-state dedup of duplicate mutations (see below) |
| `tool_call` (bash) | `command-gate.ts` | deny / ask / allow by regex rules; dedup escalation ask |
| `tool_call` (write/edit) | hooks | block or nudge on file content |
| `tool_call` (all) | `index.ts` | log-only duplicate-`toolCallId` detector |
| `tool_result` | — | appends accumulated nudges |
| `before_provider_request` | `web-search.ts` | injects server-side web search (capability, not steering) |
| `message_end` | `duplicate-delivery.ts` | drops duplicated toolCall blocks (upstream pi bug, #15) |
| `message_end` | `prose-gate.ts` | strips filler from assistant prose |

`LIUBAI_RAILS_OFF=1` disables steering handlers only; web-search, duplicate-delivery, and the detector stay on — capability and correctness, not steering — so baseline comparisons vary only the steering.

### Hook model

Content rails are Python scripts in `hooks/`, spawned per tool call with a Claude-shaped JSON payload on stdin. Exit 2 = hard block (stderr message); exit 0 with `hookSpecificOutput.additionalContext` = soft nudge, appended to the tool result and shown to the agent without blocking. This block/nudge split is the deterministic feedforward rail; `prose-gate` is the feedback lever on output.

Current rails (all deterministic, all on `write`/`edit`):

- `no_added_comments.py` — block added code comments (pragma/`noqa`/shebang exempt).
- `long_test_nudge.py` — nudge when a test body exceeds the line threshold.
- `cyclomatic_complexity_nudge.py` — nudge past the complexity threshold.
- `type_annotation_nudge.py` — nudge for missing return annotations.

The bridge in `index.ts` (`claudePayload`, `runRail`) maps pi's tool names onto the hooks' payload and interprets their exit codes. Hooks carry their own tests alongside (`test_*.py`).

### Command gate

`command-gate.ts` — regex rules from two files: global `~/.pi/agent/command-rules.json` and project `.pi/command-rules.json` (override `LIUBAI_RAILS_RULES`). Project lists replace global per-list; an explicit empty list is a definition. Precedence `deny > allow > ask`; unmatched runs. `ask` blocks in headless mode (no UI to confirm). See `.pi/command-rules.example.json`.

### Dedup

Duplicate side effects have two sources with two fixes:

- **Duplicate delivery** (upstream pi bug, #15): the openai-responses adapter can append one streamed tool call twice. `duplicate-delivery.ts` drops the extra blocks at `message_end` (keep-last — the terminal copy carries authoritative arguments); pi extracts executions and persists from the replaced message, so both double execution and doubled context are cured. A log-only detector flags any duplicate `toolCallId` that still reaches `tool_call`.
- **Duplicate intent** (model re-issues or re-adds): `bash`/`edit` are overridden via `registerTool` (`overrides.ts`) and ask "is the effect already in the world?" (`dedup.ts`): gh comment/close/reopen and git tag check live state; unqueryable mutations (`curl POST`, `npm publish`) replay a session-cached result non-error; `edit` no-ops when the inserted lines already exist in the file. A re-issue after a no-op notice escalates to a user confirm (headless: block). Commands matched by the `dedup` regex list only; `git commit`/`git push` are excluded by design (#12).

Detection always runs and logs to `~/.pi/agent/liubai-dedup-log.jsonl`; enforcement (no-op/replay/escalation) is behind `LIUBAI_DEDUP_ENFORCE=1` until log data shows an acceptable false-positive rate.

## Spawn extension

`.pi/extensions/subagent/` — a generic `spawn` tool, loaded globally by `setup.sh` into `~/.pi/agent/extensions/subagent`. It spawns a child `pi --mode rpc` per task with an isolated context window; the child process stays alive across turns and its final report lands in the parent. Two modes: single (`task`) and parallel (`tasks` array, capped at 8, concurrency 4). The `task` string carries everything — no role roster, no per-spawn system prompt. Children inherit the rails through the same global extensions dir.

Every spawn requires a `complexity` estimate (`trivial | easy | medium | hard`; per item in parallel mode, tier definitions in the tool schema). The agent never names a model: the extension resolves the tier to a model id from the user-owned table `~/.pi/agent/complexity.json` — a flat object with exactly the four tier keys and non-empty model-id strings (example: `config/complexity.example.json`) — and passes it to the child as `--model`. Missing or invalid config fails the spawn loudly; there is no fallback to the session model. The compress-bounce resumes the child session with the same resolved model.

Kept separate from rails because their lifecycles are opposite: rails inherit *into* children, whereas spawn self-disables past a depth cap so a child cannot recurse without bound. The cap rides `LIUBAI_SPAWN_DEPTH` (default 0); at depth ≥ `MAX_DEPTH` (1) `register` swaps the tool set — only `clarify` is registered (see below), `spawn` and `answer` are absent — so a child can't recurse and has no parent to answer. `runChild` sets the child's depth one above the parent's.

### Clarify / answer

A child that hits genuine ambiguity calls `clarify` — a child-only tool (registered only at max depth, see above). It wraps the question in a tagged `ctx.ui.input`; rpc mode owns stdin and routes only `extension_ui_response`, so there's no new protocol. The parent bridge intercepts the tagged `extension_ui_request`, **suspends** `spawn`, and returns *"Child asks: <Q>. Call `answer(text=…)` to reply."* `answer` (parent-only) writes `extension_ui_response {id, value}` through the same pipe; the child's `clarify` Promise resolves and the child resumes.

`runChild` splits into suspend and resume paths: on suspend, `sendPrompt` settles early on an incomplete report, so `gateChildReport` re-homes to the resume path and runs only after final settlement arrives through `answer`'s re-await.

Budget and caps, all enforced parent-side: ≤2 questions per child (`MAX_CLARIFY`); a 3rd tagged request is silently auto-denied with *"proceed with best judgment"* — the parent never sees it. The question itself is capped at 4 KB; over-cap is reject-and-return-error (the child re-asks, never told it was truncated). A 15-min timeout resolves the pending `clarify` with the best-judgment denial. Parallel mode auto-denies before suspend — a parallel child never blocks; needing clarification there is the bad-scoping symptom. `DialogGate` chains every UI dialog through a shared promise so the parent TUI shows one ask at a time. `answer` against a dead or already-finished child returns the current report rather than writing a stale response.

### Report gate

A child's final report is capped at 4 KB (4096 bytes, UTF-8) before it enters the parent context. `assessReport` sizes the report; `gateReport` orchestrates the outcome: a report under cap passes through untouched; a report over cap gets **one** compress-bounce — a follow-up `sendPrompt` on the same live rpc `ChildSession` with a compress instruction, so the parent never sees the bloated first version. If the compress still lands over cap (a second violation), the compressed result is hard-truncated at the byte boundary and flagged. If the bounce itself fails (the follow-up turn rejects or doesn't settle), `gateChildReport` falls back to hard-truncating the *original* report rather than losing the work. The child process stays alive across the task and compress turns, so the bounce reuses the live session; the compress turn inherits the same rails and the same depth cap, so it cannot recurse further. Each parallel task's report is gated independently.

## Extending

Add a content rail: drop a `hooks/foo.py` following the block/nudge exit-code contract, add a test `hooks/test_foo.py`, append its name to `RAILS` in `index.ts`. No other wiring.

Add a non-content handler: register against a pi event in `index.ts` (see pi's extension API). Steering handlers must guard on `railsDisabled()`.

## Density gating — design note

The prose-gate is the one inferential-looking lever that is actually deterministic: a conservative filler blocklist plus line/structure caps. What it can catch mechanically (filler phrases, restated prompts, summary-of-summary) it catches; what it can't (dense-but-long vs sparse-but-short — line-counting rewards terse-but-useless) it leaves alone, because a metric like lines/filler is gameable (drop banned phrases, keep reworded bloat).

The open question is the mix of dumb-deterministic plus biased-inferential (LLM judge) that lands dense without gaming. An inferential layer via `before_provider_request` would share the worker's pro-verbosity bias — wave through smooth bloat, catch clumsy filler — so it is research, not product. The deterministic gate is the trustworthy lever; the two-loop ratio from [`vision.md`](vision.md) is now cheap to test through pi's multi-layer hooks.
