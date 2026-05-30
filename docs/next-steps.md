# Next Steps

Two live paths, not yet decided:
- **A. Adopt `oh`** — configure steering on top. `oh` IS the agent, don't build it. Fast. Cost: 41.5k-LOC dep from a star-farming group (abandonment risk, not quality).
- **B. Build thin layer** — own the steering, rent the engine. Aligns with vision (contribution = steering discipline). Real cost below.

Plan: **try A first for a real feel, then scope B, then decide.**

## Step 1 — Try `oh` with ported hooks (get informed feel)

1. Port existing Claude hooks → `~/.openharness/settings.json` (`{type: command, command, matcher, block_on_failure}`). Called scripts port verbatim; only wiring rewritten.
2. Copy one Claude skill → OpenHarness skill dir, confirm `oh --dry-run` loads it (anthropic-skills compat claimed, unverified).
3. Drive real coding task on a cheap model. Judge: does the nudging *feel* right? Noise level? Friction?

This gives a concrete baseline to judge B against — don't decide blind.

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
