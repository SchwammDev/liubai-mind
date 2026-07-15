# liubai-mind

*An AI agent built on restraint.*

**留白 (liúbái)** — "leave white": the deliberate act of leaving space blank so it does the work (Chinese ink-painting tradition, Taoist roots; origin of Japanese *yohaku*/*ma*). **mind** — a thinking partner, not a task executor.

Steer agents with deterministic guardrails and dense, minimal communication — so a cheap model behaves well, and a strong one isn't drowned in noise. Domain-general: code, writing, research.

See [`docs/vision.md`](docs/vision.md) for principles, [`docs/landscape.md`](docs/landscape.md) for the tool survey, [`docs/next-steps.md`](docs/next-steps.md) for the build plan.

## Model

Not pinned. Pick in-session (`Ctrl+P`) or via `pi config`. Choice persists to `~/.pi/agent/settings.json` — local, not version-controlled. Catalog of available models lives in `~/.pi/agent/models.json` (stowed from dotfiles).

## Upgrade

`mise exec -- npm install @earendil-works/pi-coding-agent@<version> --save-exact`

## Upgrade

`mise exec -- npm install @earendil-works/pi-coding-agent@<version> --save-exact`

## Command gating

Gate bash commands by rule, not code. `.pi/command-rules.json` (project) merges over `~/.pi/agent/command-rules.json` (global); project wins per list. Three regex lists — `deny`, `ask`, `allow` — matched against the command string. Precedence `deny > allow > ask`; unmatched runs. `ask` prompts for confirmation (blocks in headless `-p`). Missing file → no gating. Copy [`.pi/command-rules.example.json`](.pi/command-rules.example.json) to start.

## Web search

On the TU Wien aqueduct provider, every request carries a server-side `web_search` tool — the gateway's OpenAI Responses API executes the search itself, so no client tool-calling is involved and weak-model tool fragility doesn't apply. Requires `api: "openai-responses"` on the provider in `~/.pi/agent/models.json`. Scoped to aqueduct; on paid providers the same tool type would incur cost. Stays active under `LIUBAI_RAILS_OFF`: capability, not steering.

## License

Copyright 2026 Bernhard Raml. Licensed under [Apache 2.0](LICENSE).
