# Oxagen memories

Durable instincts recorded by `eval-*` evaluator agents and the break-fix agent. Each entry below points to one memory file in this directory.

Format: `- [title](file-name.md) — one-line hook · type (bug|observation) · YYYY-MM-DD HH:mm[am|pm] GMT`

<!-- entries below, newest first -->
- [capability-result-publicid-asset-link-misfire](capability-result-publicid-asset-link-misfire.md) — heuristic mapped any `publicId` → asset route, so agent `agt_…` rendered a dead `/api/v1/assets/agt_…` link that surfaced API "Organization not found" JSON; gate on `gen_` value prefix · bug · 2026-06-23
- [capability-result-heuristic-record-links-fragile](capability-result-heuristic-record-links-fragile.md) — name-based deep-link inference in capability-meta over-claims on generic field names; gate on id-prefix, prefer explicit recordLinks · observation · 2026-06-23
- [github-ingestion-deliveryconfig-not-populated](github-ingestion-deliveryconfig-not-populated.md) — Zod stripped undeclared wizard fields → deliveryConfig null → owner/repo="" → GitHub 404 → 0 graph nodes · bug · 2026-06-22
