# Harness Landscape — Findings (2026-05)

Goal: slim CLI harness. Model-agnostic (cheap/weak models). Programmable hooks that **gate** (block/modify tool calls), not just notify. Skills. Low noise.

Core fact: rich gating hooks are rare. That feature defines the search. Most tools fail on it.

## Verdict

| Tool | Model-agnostic | Hooks | Slim | Note |
|---|---|---|---|---|
| **HKUDS/OpenHarness** | yes (Anthropic/OpenAI/Ollama/llama.cpp/LM Studio) | Pre/PostToolUse, `hooks/hooks.json` | ⚠️ ships bloat | closest existing; Claude-Code-shaped (`commands/*.md`, `agents/*.md`, skills, perms); Python, inspectable. BUT bundles personal agent + Slack/TG/Discord + 78 commands/42 tools |
| **MaxGfeller/open-harness** | yes (Vercel AI SDK) | hooks as lib primitives | yes (SDK) | engine to *build* your own thin layer (TS) |
| aider | yes (litellm) | none (lint/test feedback only) | very | `--lint-cmd`/`--test-cmd`/`--auto-test`, non-zero exit → retry. No hook API |
| Codex CLI | partial (OpenAI-leaning) | `notify` only (no gate) | medium | dealbreaker: notify ≠ gate |
| Claude Code + router | mostly (ANTHROPIC_BASE_URL) | best-in-class | no | keeps your hooks/skills; weak models degrade protocol |
| Rust clones (claw/claurst/rsclaw/crab*) | yes | undocumented | varies | noise/WIP/meme. skip |
| opencode | yes | plugins (weaker nudging) | no | current pain. skip |

## Build paths

- **A. Strip OpenHarness** — fork, rip out agent/chat/extra commands, keep hook+skill core. Best *if* hooks truly gate and it strips clean.
- **B. Thin layer on SDK** — own nudge loop on litellm / pydantic-ai (Python) or MaxGfeller SDK (TS). Rational if A is bloated-shut.
- **C. Scratch on litellm** — pure loop, max control, reinvents edits/diffs/tools.

## Unverified (read source before trusting)

- OpenHarness hooks: **gate vs notify?** Not confirmed at source.
- How coupled is OpenHarness bloat — strippable?
- Marketing claims ("beats Claude Code", "100% Harness-Bench") — discount.

## Links

- https://github.com/HKUDS/OpenHarness
- https://github.com/MaxGfeller/open-harness
- https://aider.chat/docs/usage/lint-test.html
- https://github.com/bradAGI/awesome-cli-coding-agents
