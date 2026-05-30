# Vision

**Working CLI, used daily, built for me.** Not a product. Shareability = free side-effect at most, never a design driver.

## North star

> Steer agents with deterministic guardrails and dense, minimal communication — so a cheap model behaves well, and a strong one isn't drowned in noise.

The contribution is the **steering discipline**. The CLI is just what makes it runnable. Don't drift into benchmarking clones.

Harness goal is **not** to remove the human. It's to **direct human attention to where it matters most** (Böckeler). Everything deterministic the harness eats; what's left for me is judgment.

## Principles

1. **Determinism over vibes.** Steering = code that gates (hooks/checks), not prose pleading. Flexibility lives *between* the rails, not by removing them. Layer it: **deterministic checks first** (lint/type/test, every change, cheap), **inferential checks second** (LLM review, gates only, expensive).
2. **Density over volume.** Every token to the agent earns its place. Anti-noise (anti-nWave). Caveman's gist, not its bulk. Information quality is the lever. — *Ma (間)*: the gap is active, not absence; restraint steers.
3. **Slim substrate.** Thin, inspectable harness. Bells/whistles = liability = surface area to confuse agent. — *Kanso (簡素)*: eliminate the non-essential.
4. **Trim output.** Bias agent toward less code, deletion, simplicity. Harness should make it write *less*.
5. **Pluggable posture.** Hooks swappable/configurable. Changing steering = config, not rewrite. (See open question.)
6. **Rules serve goals.** Counterweight to #1. Anti-pattern `obsess-over-rules`: when a rail fights the goal, the goal wins. Guardrails are a means, never the point.

## Open question — resolve by experiment, not opinion

Not leash *vs* rails. **Two loops, always both** (Böckeler):
- **Feedforward (rails/guides)** — constrain up front. Alone: "encodes rules but never finds out whether they worked."
- **Feedback (leash/sensors)** — let it act, feed failures back. Alone: "keeps repeating the same mistakes."

Real question = **ratio and placement** of the two, and whether it should **shift with model strength** (more rails on weak, more leash on strong). Core research axis, not a gap. Principle #5 exists to make answering it cheap.

## What the harness fights

Named obstacles the design must assume (Kesseler): context-rot, excess-verbosity, selective-hearing, compliance-bias (agrees but misaligned), negative-bleedthrough, non-determinism, degrades-under-complexity. Density + slim + small-steps are answers to these, not aesthetics.

## Non-goals

- Distribution / general-purpose tool
- Feature breadth
- Locking to one model vendor

## Sources

- Böckeler, *Harness Engineering* — https://martinfowler.com/articles/harness-engineering.html
- Kesseler et al., *Augmented Coding Patterns* — https://github.com/lexler/augmented-coding-patterns
