# Oxagen memories

Durable instincts recorded by `eval-*` evaluator agents and the break-fix agent. Each entry below points to one memory file in this directory.

Format: `- [title](file-name.md) — one-line hook · type (bug|observation) · YYYY-MM-DD HH:mm[am|pm] GMT`

<!-- entries below, newest first -->
- [notfound-in-route-handler-crashes-502](notfound-in-route-handler-crashes-502.md) — notFound() from a resolve-org gate has no boundary in a route.ts → uncaught throw → FUNCTION_INVOCATION_FAILED / HTTP 502 on /api/v1/mcp/oauth/authorize · bug · 2026-06-23
- [route-handlers-need-throw-safety-wrapper](route-handlers-need-throw-safety-wrapper.md) — any uncaught throw in a Next route.ts = 502; wrap GET/POST so notFound→4xx, redirect re-thrown, anything else→logged 500; route handlers are coverage-excluded so the 502 hides until prod · observation · 2026-06-23
- [github-ingestion-deliveryconfig-not-populated](github-ingestion-deliveryconfig-not-populated.md) — Zod stripped undeclared wizard fields → deliveryConfig null → owner/repo="" → GitHub 404 → 0 graph nodes · bug · 2026-06-22
