# liubai-mind

*An AI agent built on restraint.*

**留白 (liúbái)** — "leave white": the deliberate act of leaving space blank so it does the work (Chinese ink-painting tradition, Taoist roots; origin of Japanese *yohaku*/*ma*). **mind** — a thinking partner, not a task executor.

Steer agents with deterministic guardrails and dense, minimal communication — so a cheap model behaves well, and a strong one isn't drowned in noise. Domain-general: code, writing, research.

Principles in [`docs/vision.md`](docs/vision.md); how the steering is built in [`docs/architecture.md`](docs/architecture.md); why this engine in [`docs/landscape.md`](docs/landscape.md).

## Install

```
./setup.sh
```

mise + node@22, the pinned pi engine, the global steering rails, and a `liubai` command on PATH. Idempotent — re-run is safe.

## Run

```
liubai            # steering on (default)
LIUBAI_RAILS_OFF=1 liubai ...   # un-steered baseline, same engine
liubai update [version]         # bump the pinned engine (review + commit the lockfile)
```

## Configure

**Model** — not pinned. Pick in-session (`Ctrl+P`) or via `pi config`; persists to `~/.pi/agent/settings.json` (local, not version-controlled). Catalog in `~/.pi/agent/models.json`.

**Memory** — `~/.pi/agent/CLAUDE.md`, owned by you. Edit it directly to steer every session; setup neither creates nor links it.

**Command gating** — `.pi/command-rules.json` (project) merges over `~/.pi/agent/command-rules.json` (global); project wins per list. Three regex lists — `deny`, `ask`, `allow` — matched against the command string. Precedence `deny > allow > ask`; unmatched runs. `ask` prompts (blocks headless). Copy [`.pi/command-rules.example.json`](.pi/command-rules.example.json) to start.

**Web search** — on the TU Wien aqueduct provider the gateway runs `web_search` server-side, so it works even on models with unreliable tool-calling. Scoped to aqueduct; on paid providers the same tool type would incur cost. Stays on under `LIUBAI_RAILS_OFF` (capability, not steering).

## License

Copyright 2026 Bernhard Raml. Licensed under [Apache 2.0](LICENSE).
