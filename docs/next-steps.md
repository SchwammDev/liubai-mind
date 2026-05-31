# Next Steps

Two live paths, not yet decided:
- **A. Adopt `oh`** — configure steering on top. `oh` IS the agent, don't build it. Fast. Cost: 41.5k-LOC dep from a star-farming group (abandonment risk, not quality).
- **B. Build thin layer** — own the steering, rent the engine. Aligns with vision (contribution = steering discipline). Real cost below.

Plan: **try A first for a real feel, then scope B, then decide.**

## Step 1 — Try `oh` with ported hooks (get informed feel)

1. ✅ **Done (2026-05-31).** All 4 Claude hooks ported, wired in `~/.openharness/settings.json` under `pre_tool_use`, parse + register verified. Three plan assumptions proved false against v0.1.9 source — see **Porting findings** below.
2. ✅ **Done (2026-05-31).** `python-acceptance-tests` symlinked into `~/.openharness/skills/`, registers cleanly — anthropic-skills compat confirmed. Same `SKILL.md` + frontmatter format, no conversion.
3. ✅ **Done (2026-05-31).** Drove exercises 1–4 on Qwen — see **Feel-test results** below.
4. **First fresh hook: filler-phrase blocklist on agent output.** Reject "This reflects…", "It's worth noting…", "In essence…", "Overall,"… Trivial, deterministic, no length-Goodhart, kills ~80% of visible bloat. Cheapest high-value experiment.
5. **Experiment — native-concept priming.** Hypothesis: phrasing density/restraint guidance with 留白 (Hanzi) in the *injected* context (system prompt / skills / hook messages) steers Chinese-trained open models (Qwen/DeepSeek/GLM) better than English/romaji — they have denser priors for it. Caveat: these models are bilingual + English-RLHF'd, effect may dilute. Test: same hook, English vs 留白 phrasing, cheap Chinese model, compare output density. NOTE: the *project name* itself does NOT steer (not in context) — only injected prompt text does.

This gives a concrete baseline to judge B against — don't decide blind.

## `oh` command hooks (v0.1.9 source)

- Block-or-silent: runtime reads exit code only. No allow+advise channel. → all 4 ported as **hard blocks**; the 3 nudges had nowhere else to go. Leash-vs-rails ratio now a live experiment.
- Payload via env var, not stdin. Config home-only, no per-project.
- Block message must say *rejected, not applied, re-issue* or the model thrashes.
- oh tool names/fields differ from Claude (`write_file`/`edit_file`, `path`/`old_str`/`new_str`) — shim translates to Claude shape. Missing this = silent no-op on every edit.

Adapters: `.openharness/hooks/*_block.py`, reusing `.claude/hooks/` detection.

## Feel-test results (2026-05-31, Qwen via oh)

- **Clean recovery, no thrash.** Blocked edits get fixed and re-issued in sequence; the *rejected/re-issue* wording holds on a weak model. OpenCode thrash did not reproduce.
- **Rail → human escalation (ex2).** Hitting the comment gate, Qwen asked the user rather than gaming the rail — steering routed a judgment call to the human, exactly the vision's intent (rails serve goals).
- **Long-test gate + skill worked** (ex4) — behavioral naming + helper extraction held.
- **`no_comments` fires often.** Single dispatch hook (all checks → one combined block) may cut round-trips, since oh surfaces only the first block reason (N violations = N cycles). Defer until tested on a real project, not toy exercises.
- **Bash-evasion hole.** Gates see only `write_file`/`edit_file`; a `bash` heredoc write bypasses all four. Open.
- **oh flickers in tmux** at history-bottom. Cosmetic, but a daily-use-friction data point for the A-vs-B decision (oh UI maturity).

## Density gating — what's possible (design note)

Can a hook enforce density on agent output? Partially — and the gap IS the research.

- **Catchable (deterministic, cheap, do it):** hard line caps; filler-phrase blocklist; structural bloat (N+ bullets, prompt-restatement, summary-of-summary).
- **Not catchable mechanically:** dense-but-long vs sparse-but-short. Density ≠ length. Line-counting rewards terse-but-useless.
- **Goodhart trap:** metric = lines/filler → agent games it (drops banned phrases, keeps bloat reworded). Ties to principle #7.
- **Inferential layer** (OpenHarness `prompt`/`agent` hook) catches semantic bloat — BUT it's an LLM with the *same additive bias*. Judge shares defendant's flaw.

→ Real question = mix of dumb-deterministic + biased-inferential that lands dense without gaming. Measure it (= vision's two-loop open question).

## Step 2 — Research B (the engine question)

"Not much work" only holds for **B1**. Verify it's real.

- **B1 — thin layer on existing engine.** litellm (models) + a slim agent-loop-with-tools lib. Write only hooks + skills + trimmed toolset. **Open question: does a clean slim engine lib exist?** Not yet checked — this decides if B is a weekend or a month.
- **B2 — loop + tools from scratch on litellm.** Weeks. Reinvents reliable file editing (the real tax). Only if "read every line" is non-negotiable.

Effort reality: hook system = ~5% of work (the easy 60 lines). The 95% = agent loop, **reliable file editing**, tools, compaction. The 60 lines are small *because* they sit on 41k lines underneath.

## Then — decide A vs B

With A actually felt and B1 scoped.

## Refs

- Hooks schema + config paths, test/slop findings: `landscape.md`
- Principles: `vision.md`
