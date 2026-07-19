# Changelog

## 0.1.0 — 2026-07-19

First personal cut-point. Standalone: vendored rails, no dotfiles coupling.

- Vendored steering hooks (no-comments, long-test, cyclomatic-complexity, type-annotation nudges) into `.pi/extensions/rails/hooks/`.
- Command gate: regex deny/ask/allow over project + global rules files.
- Prose gate: deterministic filler stripping on assistant output.
- Server-side web search on the aqueduct provider (Responses API).
- `liubai` wrapper around the pinned pi engine; `LIUBAI_RAILS_OFF` baseline toggle.
- Docs: user-facing README, dev-facing architecture, principles vision, engine landscape.
