# Oxagen memories

Durable instincts recorded by `eval-*` evaluator agents and the break-fix agent. Each entry below points to one memory file in this directory.

Format: `- [title](file-name.md) — one-line hook · type (bug|observation) · YYYY-MM-DD HH:mm[am|pm] GMT`

<!-- entries below, newest first -->
- [mobile-composer-hidden-missing-min-h-0](mobile-composer-hidden-missing-min-h-0.md) — chat Send button pushed off-screen behind MobileBottomBar; content column lacked min-h-0 so inner scroller never engaged · bug · 2026-06-23
- [flex-min-h-0-scroll-chain-footgun](flex-min-h-0-scroll-chain-footgun.md) — every flex ancestor of the chat overflow-y-auto scroller needs min-h-0; md:flex-row hides the bug on desktop · observation · 2026-06-23
- [github-ingestion-deliveryconfig-not-populated](github-ingestion-deliveryconfig-not-populated.md) — Zod stripped undeclared wizard fields → deliveryConfig null → owner/repo="" → GitHub 404 → 0 graph nodes · bug · 2026-06-22
