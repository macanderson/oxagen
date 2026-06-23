# Oxagen memories

Durable instincts recorded by `eval-*` evaluator agents and the break-fix agent. Each entry below points to one memory file in this directory.

Format: `- [title](file-name.md) — one-line hook · type (bug|observation) · YYYY-MM-DD HH:mm[am|pm] GMT`

<!-- entries below, newest first -->
- [clickhouse-execution-step-id-nonuuid-flood](clickhouse-execution-step-id-nonuuid-flood.md) — non-UUID corr strings (embed:/dedup:/infer:/"unknown") into token_usage.execution_step_id UUID col → code-27 insert flood + unbilled embeddings; fix = pass null, coalesce to NIL_UUID at insert boundary · bug · 2026-06-23
- [clickhouse-key-column-not-nullable](clickhouse-key-column-not-nullable.md) — a MergeTree sorting-key column can't be made Nullable post-create (code 524, even with allow_nullable_key); use a nil-UUID sentinel, not a migration that breaks the deploy · observation · 2026-06-23
- [github-ingestion-deliveryconfig-not-populated](github-ingestion-deliveryconfig-not-populated.md) — Zod stripped undeclared wizard fields → deliveryConfig null → owner/repo="" → GitHub 404 → 0 graph nodes · bug · 2026-06-22
