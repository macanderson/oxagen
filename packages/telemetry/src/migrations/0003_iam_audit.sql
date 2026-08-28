-- 0003_iam_audit.sql
--
-- IAM audit_events table in ClickHouse.
--
-- This is the rich IAM-specific audit trail, separate from the Postgres
-- `security.security_events` table which handles SOC2 authz events.
-- @oxagen/iam's emit-audit.ts writes to this table from inside
-- defineContract().invoke().
--
-- Engine: ReplacingMergeTree(occurred_at) — deduplicates lazily by event_id.
-- Chain verification must use FINAL modifier or a materialised view because
-- ReplacingMergeTree deduplication is background, not immediate.
--
-- TTL: 7 years (see docs/specs/iam/plan.md §12, IAM audit retention).
--
-- Hash-chaining is implemented at write time by the application
-- (@oxagen/iam's emit-audit.ts). ClickHouse stores the pre-computed chain
-- hash as a plain String column; tamper-evidence is a write-time concern,
-- not a storage concern.

CREATE TABLE IF NOT EXISTS audit_events (
    occurred_at   DateTime64(3),
    event_id      UUID,
    org_id        UUID,
    workspace_id  Nullable(UUID),
    capability    LowCardinality(String),
    scope_kind    Enum8('org' = 1, 'workspace' = 2),
    scope_id      UUID,
    acting_principal_id   UUID,
    acting_principal_kind Enum8('human' = 1, 'agent' = 2, 'service' = 3),
    human_principal_id    Nullable(UUID),
    outcome               Enum8('allow' = 1, 'deny' = 2, 'pending_approval' = 3),
    decision_reason       LowCardinality(String),
    target_kind           Nullable(String),
    target_id             Nullable(String),
    -- SHA-256 hex of the request payload; stored for forensics, never PII.
    payload_hash  String,
    -- Chain hash: SHA-256 of (previous event_id || this event fields). Allows
    -- detection of post-hoc row insertion without a cryptographic append-only
    -- store. Verified at query time by the compliance tooling.
    chain_hash    String DEFAULT '',
    ip            Nullable(IPv6),
    ua            Nullable(String),
    request_id    UUID,
    correlation_id Nullable(UUID),
    -- Sparse JSON trace from the resolver (step-level decision log).
    trace_jsonb   String DEFAULT ''
) ENGINE = ReplacingMergeTree(occurred_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (org_id, occurred_at, event_id)
-- toDateTime(): ClickHouse TTL expressions must resolve to Date/DateTime, not
-- DateTime64 — `occurred_at` is DateTime64(3), so cast it (same pattern as the
-- other telemetry tables in schema.sql).
TTL toDateTime(occurred_at) + INTERVAL 7 YEAR;
