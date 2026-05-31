# Next Steps

Two live paths, not yet decided:
- **A. Adopt `oh`** — configure steering on top. `oh` IS the agent, don't build it. Fast. Cost: 41.5k-LOC dep from a star-farming group (abandonment risk, not quality).
- **B. Build thin layer** — own the steering, rent the engine. Aligns with vision (contribution = steering discipline). Real cost below.

Plan: **try A first for a real feel, then scope B, then decide.**

## Step 1 — Try `oh` with ported hooks (get informed feel)

1. ✅ **Done (2026-05-31).** All 4 Claude hooks ported, wired in `~/.openharness/settings.json` under `pre_tool_use`, parse + register verified. Three plan assumptions proved false against v0.1.9 source — see **Porting findings** below.
2. ✅ **Done (2026-05-31).** `python-acceptance-tests` symlinked into `~/.openharness/skills/`, registers cleanly — anthropic-skills compat confirmed. Same `SKILL.md` + frontmatter format, no conversion.
3. ✅ **Done (2026-05-31).** Drove exercises 1–4 on Qwen — see **Feel-test results** below.
4. ⛔ **Blocked on A (2026-05-31).** Filler-phrase blocklist on agent prose — trivial logic (reject "This reflects…", "It's worth noting…", "In essence…", "Overall,"…), but **oh has no event that can gate assistant text.** Scoped the event model against source — see **Hook event model** below. The only turn-end event (`STOP`) is blind to the prose and fire-and-forget. Gating prose needs an oh-source patch (fork the engine) or path B. Was billed "cheapest high-value experiment"; it's actually the first hard A-vs-B signal: **A cannot steer output density at all without forking.**
5. **Experiment — native-concept priming.** Hypothesis: phrasing density/restraint guidance with 留白 (Hanzi) in the *injected* context (system prompt / skills / hook messages) steers Chinese-trained open models (Qwen/DeepSeek/GLM) better than English/romaji — they have denser priors for it. Caveat: these models are bilingual + English-RLHF'd, effect may dilute. Test: same hook, English vs 留白 phrasing, cheap Chinese model, compare output density. NOTE: the *project name* itself does NOT steer (not in context) — only injected prompt text does.

This gives a concrete baseline to judge B against — don't decide blind.

## Hook event model (v0.1.9 source)

Ten events (`hooks/events.py`): `session_start/end`, `pre/post_compact`, `pre/post_tool_use`, `user_prompt_submit`, `notification`, `stop`, `subagent_stop`. Four hook *types* (`schemas.py`): `command`, `http`, and two LLM validators (`prompt`, `agent`). **Only some events can gate; payloads differ per event:**

| Event | Payload carries | Result | Gates? |
|-------|-----------------|--------|--------|
| `pre_tool_use` | `tool_name`, `tool_input` | captured; `blocked` → error tool-result fed back to model | **yes** — what all 4 hooks ride |
| `stop` (turn end, no tool calls) | `event`, `stop_reason` **only** | discarded, immediate `return` | **no** |
| `user_prompt_submit` | the user prompt | — | (user text, not model) |
| `post_tool_use` | tool output | — | post-hoc |

**Assistant prose is unhookable.** `final_message.text` exists at turn end (yielded to the UI as `AssistantTurnComplete`) but is never placed in any hook payload, and `stop` ignores its hook's return. So no event — `command` *or* LLM (`prompt`/`agent`) — can see or block model output. This is why item 4 is blocked on A (`query.py:806-815` vs `:881-891`).

## `oh` command hooks (v0.1.9 source)

- Block-or-silent: runtime reads exit code only. No allow+advise channel. → all 4 ported as **hard blocks**; the 3 nudges had nowhere else to go. Leash-vs-rails ratio now a live experiment.
- Payload via env var, not stdin. Config home-only, no per-project.
- Block message must say *rejected, not applied, re-issue* or the model thrashes.
- oh tool names/fields differ from Claude (`write_file`/`edit_file`, `path`/`old_str`/`new_str`) — bridge translates to Claude shape. Missing this = silent no-op on every edit.

Steering lives in dotfiles (`claude/code/.claude-utils/oh_bridge.py` + test), mirroring the opencode bridge: one script imports the shared `hooks/` detection core, translates oh's env payload, dispatches all checks, and **aggregates into one combined block** (one re-issue, not N). Wired globally via `~/.openharness/settings.json` → `python3 $HOME/.../oh_bridge.py` (`$HOME` shell-expands, portable).

## Feel-test results (2026-05-31, Qwen via oh)

- **Clean recovery, no thrash.** Blocked edits get fixed and re-issued in sequence; the *rejected/re-issue* wording holds on a weak model. OpenCode thrash did not reproduce.
- **Rail → human escalation (ex2, reproduced).** Across reruns, hitting the rules-vs-`CLAUDE.md` conflict, Qwen repeatedly surfaced it as a question to the user rather than gaming the rail — matches the vision's intent (rails serve goals). No longer a single observation; holds across runs.
- **Long-test gate + skill worked** (ex4) — behavioral naming + helper extraction held.
- **`no_comments` fires often → solved by the bridge.** oh surfaces only the first block reason (N violations = N cycles), so the bridge aggregates all checks into one combined block — one re-issue regardless of violation count.
- **Comment-vs-docstring confusion (Qwen).** Block says "Comments"; model reasons docstrings are exempt, strips only `#` lines, keeps the docstring, re-submits, gets re-blocked — one wasted cycle. The hook *does* catch docstrings; the message wording was the gap — both block messages now name docstrings explicitly (dotfiles `6227f44`). Policy confirmed: docstrings stay banned for internal dev; a dedicated hooks-off session covers the rare API-endpoint case where they earn their place.
- **Bash-evasion hole.** Gates see only `write_file`/`edit_file`; a `bash` heredoc write bypasses all four. Open.
- **oh UX rough** — A-adoption friction, not correctness: flickers in tmux at history-bottom; interrupt unreliable (must spam `esc` before a stop registers); denying a tool call doesn't prompt "what should the agent do instead" the way Claude Code does, so the steer is lost. Daily-use-friction data points for A-vs-B (oh UI maturity).

## Density gating — what's possible (design note)

Can a hook enforce density on agent output? Partially — and the gap IS the research.

- **Catchable (deterministic, cheap, do it):** hard line caps; filler-phrase blocklist; structural bloat (N+ bullets, prompt-restatement, summary-of-summary).
- **Not catchable mechanically:** dense-but-long vs sparse-but-short. Density ≠ length. Line-counting rewards terse-but-useless.
- **Goodhart trap:** metric = lines/filler → agent games it (drops banned phrases, keeps bloat reworded). Ties to principle #7.
- **Inferential layer** (OpenHarness `prompt`/`agent` hook) could catch semantic bloat in principle — BUT (a) on oh it never sees model output (no event carries assistant text — see **Hook event model**), and (b) it's an LLM with the *same additive bias*: judge shares defendant's flaw. So on A it's doubly dead; on B it's buildable but suspect.

→ Real question = mix of dumb-deterministic + biased-inferential that lands dense without gaming. Measure it (= vision's two-loop open question). Note: any prose-density gate at all presupposes B (or an oh patch), since A can't hook output.

## Step 2 — Research B (the engine question)

"Not much work" only holds for **B1**. Verify it's real.

- **B1 — thin layer on existing engine.** litellm (models) + a slim agent-loop-with-tools lib. Write only hooks + skills + trimmed toolset. **Open question: does a clean slim engine lib exist?** Not yet checked — this decides if B is a weekend or a month.
- **B2 — loop + tools from scratch on litellm.** Weeks. Reinvents reliable file editing (the real tax). Only if "read every line" is non-negotiable.

Effort reality: hook system = ~5% of work (the easy 60 lines). The 95% = agent loop, **reliable file editing**, tools, compaction. The 60 lines are small *because* they sit on 41k lines underneath.

## Then — decide A vs B

With A actually felt and B1 scoped.

**Hard constraint surfaced (2026-05-31):** A can gate *edits* (file writes) but is structurally blind to *prose* — no oh event exposes or blocks assistant text (see **Hook event model**). Output-density / restraint steering (留白) is central to the contribution thesis, so on this axis A is disqualified without forking the engine. Decision now forks: if prose steering is in-scope → B (or upstream a STOP-payload PR to oh); if only edit-time rails matter → A stays viable.

## Refs

- Hooks schema + config paths, test/slop findings: `landscape.md`
- Principles: `vision.md`
