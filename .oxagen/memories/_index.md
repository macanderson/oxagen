# Oxagen memories

Durable instincts recorded by `eval-*` evaluator agents and the break-fix agent. Each entry below points to one memory file in this directory.

Format: `- [title](file-name.md) — one-line hook · type (bug|observation) · YYYY-MM-DD HH:mm[am|pm] GMT`

<!-- entries below, newest first -->
- [capability-result-publicid-asset-link-misfire](capability-result-publicid-asset-link-misfire.md) — heuristic mapped any `publicId` → asset route, so agent `agt_…` rendered a dead `/api/v1/assets/agt_…` link that surfaced API "Organization not found" JSON; gate on `gen_` value prefix · bug · 2026-06-23
- [capability-result-heuristic-record-links-fragile](capability-result-heuristic-record-links-fragile.md) — name-based deep-link inference in capability-meta over-claims on generic field names; gate on id-prefix, prefer explicit recordLinks · observation · 2026-06-23
- [mobile-composer-hidden-missing-min-h-0](mobile-composer-hidden-missing-min-h-0.md) — chat Send button pushed off-screen behind MobileBottomBar; content column lacked min-h-0 so inner scroller never engaged · bug · 2026-06-23
- [flex-min-h-0-scroll-chain-footgun](flex-min-h-0-scroll-chain-footgun.md) — every flex ancestor of the chat overflow-y-auto scroller needs min-h-0; md:flex-row hides the bug on desktop · observation · 2026-06-23
- [clickhouse-execution-step-id-nonuuid-flood](clickhouse-execution-step-id-nonuuid-flood.md) — non-UUID corr strings (embed:/dedup:/infer:/"unknown") into token_usage.execution_step_id UUID col → code-27 insert flood + unbilled embeddings; fix = pass null, coalesce to NIL_UUID at insert boundary · bug · 2026-06-23
- [clickhouse-key-column-not-nullable](clickhouse-key-column-not-nullable.md) — a MergeTree sorting-key column can't be made Nullable post-create (code 524, even with allow_nullable_key); use a nil-UUID sentinel, not a migration that breaks the deploy · observation · 2026-06-23
- [github-ingestion-deliveryconfig-not-populated](github-ingestion-deliveryconfig-not-populated.md) — Zod stripped undeclared wizard fields → deliveryConfig null → owner/repo="" → GitHub 404 → 0 graph nodes · bug · 2026-06-22
