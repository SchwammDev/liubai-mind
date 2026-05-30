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

- **A. Adopt OpenHarness (configure, don't fork)** — `pip install openharness-ai`, point at cheap model, author hooks + skills + trimmed tool list. Steering surface stays slim; runtime is commodity. **Recommended** — only option with the full trifecta, near-zero build cost.
- **B. Thin layer on SDK** — own nudge loop on litellm / pydantic-ai (Python). Fallback if A's youth/quality disappoints on real use.
- **C. Scratch on litellm** — pure loop, max control, reinvents edits/diffs/tools. Only if "read every line" slim is non-negotiable.

## OpenHarness source dive (2026-05-30) — RESOLVED

13k★, Python, `pip install openharness-ai`, run `oh`.

**Hooks GATE — yes.** 4 types, each with `block_on_failure`:
- `command` (shell) = deterministic
- `prompt`/`agent` (LLM check, cheap/deep) = inferential
- `http` (POST payload)
- `matcher` (glob on tool_name), `priority`, hot-reload. Events = full Claude-Code parity (pre/post-tool, prompt-submit, stop, compact, session).
- Limit: allow/block only, **no input rewrite** (same as Claude Code).
- → vision's deterministic-first/inferential-second = native hook taxonomy. Pluggable posture (#5) = `hot_reload`.

**Model-agnostic — yes.** Ollama/DeepSeek/Groq/OpenRouter/Kimi/GLM + any OpenAI/Anthropic-compatible endpoint, per-profile keys. Cheap/local solved.

**Skills — yes**, Claude-Code skills & plugins compatible (README). Existing skills likely port.

**Slim — partial.** Core decoupled from `ohmo`/dashboard bloat (separate dirs, no import). BUT 280 core .py files, 44 built-in tools. NOT Kanso-slim; it's a full Claude-Code reimplementation.

**Verdict.** Only option hitting all of {gating hooks, model-agnostic+local, CC-skills-compatible}. Fits "slim" = *my steering surface is tiny, runtime is commodity* (vision's own framing). Fails "slim" = *I read every line*. Adopt-and-configure, don't fork.

## Smoke test (2026-05-30, playground/, v0.1.9)

Ran it. Results:

- **Install clean.** `pip install openharness-ai`, one shot, no drama.
- **CLI is to-the-point** — help output is Claude-Code-shaped (`--print`, `--permission-mode`, `--allowed-tools`, `--dry-run`). The README noise does NOT carry into the CLI/code. README ≠ product here.
- **Gating PROVEN empirically** (drove `HookExecutor` directly): failing `command` hook + `block_on_failure:true` → `blocked=True`; `:false` → `False`; non-matching tool → `False`. Behaves exactly as source claims.
- **Local weak model works end-to-end.** Ollama `llama3.2:3b` via `provider add` (openai api-format, `localhost:11434/v1`) → `oh -p` → clean output. The cheap-model case is real.
- **Code quality good** where it counts: `hooks/loader.py` (60 lines), `config/paths.py` clean/typed/single-responsibility. Contradicts the README vibe.

Config: `~/.openharness/settings.json` (or `OPENHARNESS_CONFIG_DIR`, or per-project `<cwd>/.openharness/`). Hooks shape: `{"hooks":{"pre_tool_use":[{"type":"command","command":...,"matcher":...,"block_on_failure":true}]}}`.

Risks remaining: young + fast-moving (0.1.4→0.1.9 within days), longevity unproven, no control of direction. But the core bet is validated.

Discounted marketing: "beats Claude Code / 100% Harness-Bench".

## Links

- https://github.com/HKUDS/OpenHarness
- https://github.com/MaxGfeller/open-harness
- https://aider.chat/docs/usage/lint-test.html
- https://github.com/bradAGI/awesome-cli-coding-agents
