# Architecture

Dev-facing. How the steering layer is built and extended.

## Substrate

Engine = pi (`@earendil-works/pi-coding-agent`), pinned and vendored via npm. The contribution is the steering layer on top; pi ships the editor, the hooks, the runtime. See [`landscape.md`](landscape.md) for why pi over alternatives.

## Rails extension

`.pi/extensions/rails/` — one pi extension (`index.ts`), loaded globally by `setup.sh` into `~/.pi/agent/extensions/rails`. Four event handlers:

| Event | Handler | Steers |
|---|---|---|
| `tool_call` (bash) | `command-gate.ts` | deny / ask / allow by regex rules |
| `tool_call` (write/edit) | hooks | block or nudge on file content |
| `tool_result` | — | appends accumulated nudges |
| `before_provider_request` | `web-search.ts` | injects server-side web search (capability, not steering) |
| `message_end` | `prose-gate.ts` | strips filler from assistant prose |

`LIUBAI_RAILS_OFF=1` disables steering handlers only; web-search stays on so baseline comparisons vary only the steering, never reach.

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

## Spawn extension

`.pi/extensions/subagent/` — a generic `spawn` tool, loaded globally by `setup.sh` into `~/.pi/agent/extensions/subagent`. It spawns a child `pi --mode json -p --no-session` per task with an isolated context window; the child's final report lands in the parent. Two modes: single (`task`) and parallel (`tasks` array, capped at 8, concurrency 4). The `task` string carries everything — no role roster, no per-spawn system prompt. Children inherit the rails through the same global extensions dir.

Kept separate from rails because their lifecycles are opposite: rails inherit *into* children, whereas spawn self-disables past a depth cap so a child cannot recurse without bound. The cap rides `LIUBAI_SPAWN_DEPTH` (default 0); `register` skips the tool entirely at depth ≥ `MAX_DEPTH` (1), so spawn is absent — not merely blocked — in children. `runChild` sets the child's depth one above the parent's.

## Extending

Add a content rail: drop a `hooks/foo.py` following the block/nudge exit-code contract, add a test `hooks/test_foo.py`, append its name to `RAILS` in `index.ts`. No other wiring.

Add a non-content handler: register against a pi event in `index.ts` (see pi's extension API). Steering handlers must guard on `railsDisabled()`.

## Density gating — design note

The prose-gate is the one inferential-looking lever that is actually deterministic: a conservative filler blocklist plus line/structure caps. What it can catch mechanically (filler phrases, restated prompts, summary-of-summary) it catches; what it can't (dense-but-long vs sparse-but-short — line-counting rewards terse-but-useless) it leaves alone, because a metric like lines/filler is gameable (drop banned phrases, keep reworded bloat).

The open question is the mix of dumb-deterministic plus biased-inferential (LLM judge) that lands dense without gaming. An inferential layer via `before_provider_request` would share the worker's pro-verbosity bias — wave through smooth bloat, catch clumsy filler — so it is research, not product. The deterministic gate is the trustworthy lever; the two-loop ratio from [`vision.md`](vision.md) is now cheap to test through pi's multi-layer hooks.
