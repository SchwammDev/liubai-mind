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
- `matcher` (glob on tool_name — not regex), hot-reload. Events = full Claude-Code parity (pre/post-tool, prompt-submit, stop, compact, session).
- Command hooks: payload via env var `OPENHARNESS_HOOK_PAYLOAD` (not stdin). **Block-or-silent** — runtime reads exit code only; no `additionalContext`/advise channel, successful stdout is discarded. Block = exit non-zero + `block_on_failure`.
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

## Is it slop? — measured (cloned repo, 2026-05-30)

Suspicion raised by group's star-farming culture (see provenance). Checked craftsmanship directly instead of trusting:

- **Package code (215 files, 41.5k LOC):** 80% of defs type-hinted (1268/1575), **0 bare excepts**, 7 TODO/FIXME total, 152/215 files <150 LOC. Surface craftsmanship = real, not slop.
- **Test suite (full git clone):** ~119 test files under `tests/test_*/` (one dir per subsystem), 1054 test functions, ~2877 asserts (static count). Real structure mirroring src, not stubs.
- **Actually ran (verified):** `tests/test_hooks` → **11 passed**. Core dirs `test_hooks test_skills test_plugins test_permissions test_config test_tools` → **266 passed, 2 failed**; both failures environmental (test expects `python` on PATH, we have `python3`; one timing-flaky agent test), not defects.

**Conclusion:** competently engineered, real test discipline. NOT slop. Surface metrics can't catch *logic* slop (wrong abstractions, subtle bugs) — but the evidence strongly favors real craft.

**The real problem is NOT quality — it's two things:**
1. **Not slim.** 41.5k LOC = full Claude-Code reimplementation. Bloat (cli 2464, autopilot 2239, feishu/swarm/channels) is in layers you don't use, but it's there.
2. **Trust/longevity.** Group (HKUDS/Chao Huang) clearly star-farms & overhypes: paper repos sit at <1k★ while "product" repos cluster at 13-36k★; courts the OpenClaw hype ecosystem (375k★, Peter Steinberger's — NOT theirs; ClawTeam IS theirs, "Roadmap" only). Good engineers who also hype-farm — both true. Risk = abandonment when they chase the next shiny thing, not correctness.

Config: `~/.openharness/settings.json` or `OPENHARNESS_CONFIG_DIR` only — **no per-project `<cwd>/.openharness/`** (v0.1.9, verified). Hooks shape: `{"hooks":{"pre_tool_use":[{"type":"command","command":...,"block_on_failure":true}]}}`.

Risks remaining: young + fast-moving (0.1.4→0.1.9 within days), longevity unproven, no control of direction. But the core bet is validated.

## Who's behind it (2026-05-30)

**Data Intelligence Lab@HKU** (org `HKUDS`), led by **Chao Huang**, Assistant Professor, University of Hong Kong. Research: LLMs, agents, graph learning, RAG.

- Chao Huang: "World's Top 2% Scientists", multiple Most-Influential-Paper rankings (WWW/SIGIR/KDD/CIKM). Real reputation, not anon.
- Lab track record: **LightRAG** (36k★, EMNLP'25), **RAG-Anything** (21k★), **AI-Researcher** (5k★, NeurIPS'25). Ships widely-used OSS, not fly-by-night.
- OpenHarness: MIT, created 2026-04-01, **49 contributors, 2.2k forks, 13k★**, active (pushed 2026-05-27). Real community traction already.

Read: **academic lab, strong OSS track record, named accountable PI.** Trust↑ on provenance. Caveat — academic labs optimize for papers/stars/demos, not long-term product maintenance. Flagship (LightRAG) is sustained; whether OpenHarness gets that or becomes an abandoned demo is the open bet. MIT = forkable if abandoned. Tagline self-describes "80% of agent functionality in 3% of the code" — aligns with our slim thesis (verify, don't trust).

Discounted marketing: "beats Claude Code / 100% Harness-Bench".

## Links

- https://github.com/HKUDS/OpenHarness
- https://github.com/MaxGfeller/open-harness
- https://aider.chat/docs/usage/lint-test.html
- https://github.com/bradAGI/awesome-cli-coding-agents
