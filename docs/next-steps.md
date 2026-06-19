# Next Steps

Engine = pi (see [`landscape.md`](landscape.md)). Build the steering layer as pi extensions.

## First slice

- Port dotfiles steering checks (no-comments/docstrings, line caps, filler blocklist) → pi extension; `tool_call` gate on `write`/`edit`. The rails, already written.
- Add the gate `oh` couldn't: `message_end` strips filler / caps lines on assistant prose. The 留白 lever.
- Wire as `.pi/extensions/`, run on a daily task, feel it.

## Open constraints

- **Tool-calling is tiered.** Weak local models (llama3.2:3b, mistral-nemo:12b, llama3.1:8b) leak tool calls as text via Ollama `/v1` → rails never fire (engine-independent). Capable tier = TU Wien **aqueduct** (Qwen flagship, OpenAI-compat) — expected to tool-call properly; verify, then re-prove the `tool_call` gate there. Weak-local = degraded floor; prose-gate works on both.
- **VC drift.** pi relicensing RFC 0015 → pin version, vendor engine.

## Density gating — design note

- **Catchable deterministically (do it):** line caps, filler-phrase blocklist, structural bloat (N+ bullets, prompt-restatement, summary-of-summary).
- **Not mechanical:** dense-but-long vs sparse-but-short. Line-counting rewards terse-but-useless.
- **Goodhart:** metric = lines/filler → agent games it (drops banned phrases, keeps reworded bloat). Ties to principle #7.
- **Inferential layer** (pi `before_provider_request` / LLM judge): shares the worker's pro-verbosity bias → waves through smooth bloat, catches clumsy filler. Research, not product.
- **Deterministic gate = the trustworthy lever.** Real question = mix of dumb-deterministic + biased-inferential that lands dense without gaming — vision's two-loop open question, now cheap to test via pi's multi-layer hooks.

## Refs

- Engine + field: [`landscape.md`](landscape.md)
- Principles + open question: [`vision.md`](vision.md)
