# Next Steps

Decision: adopt OpenHarness (`oh`). `oh` IS the chat agent — don't build/port it. Configure steering on top.

## Tasks

1. **Verify skill portability.** Copy one Claude skill → OpenHarness skill dir, confirm `oh --dry-run` loads it. Cheap. README claims anthropic-skills compatible — unverified.
2. **Re-express hooks** (not copy). Concepts map 1:1; format differs. Claude `settings.json` PreToolUse/exit-code-2 → OpenHarness `~/.openharness/settings.json` `{type: command/prompt/http/agent, block_on_failure, matcher}`. Called scripts port verbatim; wiring rewritten.
3. **Author fresh steering** — the actual contribution. New hooks/skills against the slim thesis.

## Open fork (decide first)

**Port-vs-fresh.** Drag over Claude-era hooks/skills, or author minimal new ones against vision? Slim rebuild leans fresh.

## Refs

- Hooks schema + config paths: `landscape.md` smoke-test section
- Principles: `vision.md`
