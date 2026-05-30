# Vision

**Working CLI, used daily, built for me.** Not a product. Shareability = free side-effect at most, never a design driver.

## North star

> Steer agents with deterministic guardrails and dense, minimal communication — so a cheap model behaves well, and a strong one isn't drowned in noise.

The contribution is the **steering discipline**. The CLI is just what makes it runnable. Don't drift into benchmarking clones.

Harness goal is **not** to remove the human. It's to **direct human attention to where it matters most** (Böckeler). Everything deterministic the harness eats; what's left for me is judgment.

## Principles

1. **Determinism over vibes.** Steering = code that gates (hooks/checks), not prose pleading. Flexibility lives *between* the rails, not by removing them. Layer it: **deterministic checks first** (lint/type/test, every change, cheap), **inferential checks second** (LLM review, gates only, expensive).
2. **Density over volume.** Every token to the agent earns its place. Anti-noise. Caveman's gist, not its bulk. Information quality is the lever. — *Ma (間)*: the gap is active, not absence; restraint steers.
3. **Generation is cheap, consumption is not.** The project seed. Agents removed the *production* cost of ceremony (docs, reviews, reports) but not the *consumption* cost. So ceremony goes unbounded — the bill lands on the reader (worst on humans). Ceremony was once self-limiting *because* a human paid to write it; remove that cost, remove the bound. Price every generated artifact by what it costs to *read*, not to *produce*. See verified example: nWave.
4. **Slim substrate.** Thin, inspectable harness. Bells/whistles = liability = surface area to confuse agent. — *Kanso (簡素)*: eliminate the non-essential.
5. **Trim output.** Bias agent toward less code, deletion, simplicity — and toward fewer/shorter *artifacts of every kind* (not just code: docs, reviews, summaries). Harness should make it produce *less*. Direct consequence of #3.
6. **Pluggable posture.** Hooks swappable/configurable. Changing steering = config, not rewrite. (See open question.)
7. **Rules serve goals.** Counterweight to #1. Anti-pattern `obsess-over-rules`: when a rail fights the goal, the goal wins. Guardrails are a means, never the point.

## Open question — resolve by experiment, not opinion

Not leash *vs* rails. **Two loops, always both** (Böckeler):
- **Feedforward (rails/guides)** — constrain up front. Alone: "encodes rules but never finds out whether they worked."
- **Feedback (leash/sensors)** — let it act, feed failures back. Alone: "keeps repeating the same mistakes."

Real question = **ratio and placement** of the two, and whether it should **shift with model strength** (more rails on weak, more leash on strong). Core research axis, not a gap. Principle #6 exists to make answering it cheap.

## What the harness fights

Named obstacles the design must assume (Kesseler): context-rot, excess-verbosity, selective-hearing, compliance-bias (agrees but misaligned), negative-bleedthrough, non-determinism, degrades-under-complexity. Density + slim + small-steps are answers to these, not aesthetics.

**The agent is not an ally of these principles.** Models are trained to be helpful = additive: more context, fuller prose, completeness. The bloat reflex always runs; its cost is just usually invisible. Same reflex that caught nWave's authors, and that re-padded principle #3 mid-edit. Implication: don't trust the agent's intent to be terse — **gate density deterministically.** This is itself an argument for the whole approach.

## Verified anti-example — nWave

nWave (`nwave.ai`): spec-driven multi-agent methodology inside Claude Code — 22 agents, 7 waves, 11 quality gates, runtime TDD enforcement. Built by SWEs whose ceremony instincts are sound. Tried it firsthand.

**What went wrong (observed, not theorized):** even after choosing nWave's own skip/shortcut, shipping a simple feature took ages — too many reviews, mountains of never-trimmed documentation. Re-did the same feature with simpler hooks: faster, higher quality.

**The lesson — two layers:**
- Symptom = `obsess-over-rules` (slow *despite* opting to shortcut).
- Root cause = principle #3: they price ceremony at its old human-production cost while agents made production ~free and left consumption cost untouched. Good engineers lost in the *ease* of ceremony agents now enable.

This is the experience that prompted the project.

## Non-goals

- Distribution / general-purpose tool
- Feature breadth
- Locking to one model vendor

## Sources

- Böckeler, *Harness Engineering* — https://martinfowler.com/articles/harness-engineering.html
- Kesseler et al., *Augmented Coding Patterns* — https://github.com/lexler/augmented-coding-patterns
- nWave (verified anti-example) — https://nwave.ai · https://github.com/nWave-ai/nWave
