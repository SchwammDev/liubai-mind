# Harness Landscape

Need: slim CLI harness, model-agnostic (cheap/local), hooks that **gate** — block/modify tool calls *and* assistant prose — low noise. Gating tool-hooks are rare; prose-gating rarer. Prose-gating is the deciding axis (central to 留白).

## Choice — pi (`@earendil-works/pi-coding-agent`)

Rented as the engine; contribution = steering extensions on top. Verified by spike (`playground/pi-spike/`):

- **Prose gate** — `message_end` returns `{message}` to replace finalized assistant text. Proven on local llama3.2:3b. **Only surveyed engine with this.**
- **Tool gate** — `tool_call` returns `{block, reason}`; mutate `event.input` in place to rewrite args.
- **Extra steering layers** — `before_agent_start` (replace system prompt, chainable → 留白 priming), `context` (rewrite messages), `before_provider_request` (replace payload).
- Ships reliable fuzzy edit tool (the expensive 95%); model-agnostic incl. Ollama; extensions = `export default (pi)=>{}` TS via jiti, no build step.

Authors real (Zechner/libGDX, Ronacher/Flask), ~1.8M weekly npm downloads. Needs node ≥22.19. Risk: VC-backed (Earendil; Accel/Balderton), relicensing RFC 0015 → pin version + vendor engine.

## Field — rejected

| Tool | Why not |
|---|---|
| OpenHarness `oh` | no prose-gate hook (kills 留白 thesis); 41k LOC; poor UX (no reconnect, broken paste, flicker); star-farm provenance |
| Python lift (mini-swe / `llm` + vendored aider editblock) | viable — tool-gate yes, prose-gate self-built. pi ships both |
| Framework-rent (Strands, OpenAI Agents SDK) | ship editor + gate but heavy, no prose-gate, big unread engine |
| aider · Codex · opencode · Rust clones | no gating-hook API |

## Decisive criteria

1. **Prose-gating** — gate assistant text, not just tools. Only pi.
2. **Gating tool-hooks** — block/modify before execution.
3. **Reliable fuzzy edit tool** shipped (the 95%).
4. **Model-agnostic** incl. local.
5. **Slim** = tiny steering surface; runtime is commodity.
