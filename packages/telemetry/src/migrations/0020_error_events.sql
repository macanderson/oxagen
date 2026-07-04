-- 0020_error_events.sql
--
-- Append-only runtime error stream (ClickHouse is the correct store for
-- runtime events — see the four-store data model in CLAUDE.md). One row per
-- high-severity / unhandled error captured by @oxagen/telemetry's
-- captureError() from the server runtimes (apps/api, apps/app server side,
-- apps/mcp, inngest functions). Distinct from `security_events` (Postgres,
-- SOC2 authz audit) and `tool_invocations.error_class` (per-call analytics):
-- this table is the operational error-triage surface that drives alerting.
--
-- Vendor-neutral: no Sentry/Datadog SDK. Errors land here; an optional
-- outbound webhook (ALERT_WEBHOOK_URL) fans a Slack-compatible payload.
--
-- Scope sentinels: org_id / workspace_id default to the nil UUID because an
-- error can occur before a tenant scope is ever resolved (e.g. an auth failure
-- or a boot-time crash). captureError() coalesces "no scope" to the nil UUID
-- at the insert boundary, mirroring token_usage.execution_step_id.
--
-- PII posture: `message` and `stack` are truncated to bounded lengths at the
-- capture boundary; error messages are operational triage data, not user
-- content. NEVER pass prompt text, secrets, or raw request bodies here.
--
-- Engine: MergeTree (pure append-only fire-and-forget). 90-day TTL matches the
-- other 90-day runtime-event tables (events, execution_logs).
CREATE TABLE IF NOT EXISTS error_events (
  -- Random per-error UUID, generated at capture time.
  error_id UUID,

  -- Tenant scope. Nil UUID when the error occurred before scope resolution.
  org_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  workspace_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),

  -- "fatal" | "error" | "warn". LowCardinality — the set is tiny and fixed.
  severity LowCardinality(String) DEFAULT 'error',

  -- Which server runtime captured it: "api" | "app" | "mcp" | "inngest" |
  -- "runner". LowCardinality — small fixed set.
  source LowCardinality(String) DEFAULT '',

  -- Error constructor name (e.g. "TypeError", "CapabilityError"). Bounded set
  -- in practice but kept String (not LowCardinality) to tolerate custom names.
  error_class String DEFAULT '',

  -- Truncated error message (bounded at capture). ZSTD — repetitive text.
  message String CODEC(ZSTD(3)),

  -- Truncated stack trace (bounded at capture). ZSTD — highly compressible.
  stack String CODEC(ZSTD(3)),

  -- Capability name when the error came from a kernel invocation, else ''.
  capability String DEFAULT '',

  -- Request/correlation id when available, else ''.
  request_id String DEFAULT '',

  -- Stable grouping key: SHA-256(error_class + normalized message), first 16
  -- bytes hex. Lets dashboards/alert dedup collapse the same error across
  -- occurrences without the raw message. PII-free.
  fingerprint String DEFAULT '',

  -- OTEL correlation — join to spans/token_usage/tool_invocations. Empty when
  -- no trace is active (OTEL not initialised or no active span).
  trace_id String DEFAULT '',
  span_id String DEFAULT '',

  -- Capture time (server-stamped). ISO-8601 ingested via best_effort.
  created_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),

  -- Secondary filters not led by the sort key: severity for "fatals only"
  -- dashboards, fingerprint for grouped occurrence counts.
  INDEX idx_error_severity severity TYPE set(0) GRANULARITY 4,
  INDEX idx_error_fingerprint fingerprint TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, source, created_at)
TTL toDateTime(created_at) + INTERVAL 90 DAY;
