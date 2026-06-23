-- 0011_codecs_lowcardinality.sql
--
-- Storage + scan optimizations on the SURVIVING telemetry tables (after 0010
-- dropped the dead ones). Each ALTER preserves the column's EXACT existing
-- type and ONLY adds a compression codec (or, for skill_loads.surface, narrows
-- a bounded plain String to LowCardinality). No ORDER BY / engine / drop
-- changes. MODIFY COLUMN is a metadata change + background mutation; idempotent
-- to re-run (the codec/type is simply re-asserted).
--
-- Codec rationale (telemetry is append-heavy):
--   - timestamps  → CODEC(DoubleDelta, ZSTD(1)): monotonic-ish event times
--     compress ~10x with delta-of-delta.
--   - blob String → CODEC(ZSTD(3)): JSON/text payloads are the biggest on-disk
--     consumers.
--   - high-volume UInt64 token/cost counters → CODEC(T64, ZSTD(1)): T64 packs
--     the used bit-range, ZSTD finishes the job.
--
-- The audit_events ORDER BY rebuild is intentionally NOT done here (heaviest;
-- left as a proposal). Columns that are already LowCardinality are untouched.

-- ── execution_logs ──────────────────────────────────────────────────────────
ALTER TABLE execution_logs MODIFY COLUMN created_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1));
ALTER TABLE execution_logs MODIFY COLUMN message String CODEC(ZSTD(3));
ALTER TABLE execution_logs MODIFY COLUMN metadata String CODEC(ZSTD(3));

-- ── events ──────────────────────────────────────────────────────────────────
ALTER TABLE events MODIFY COLUMN emitted_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1));
ALTER TABLE events MODIFY COLUMN payload String CODEC(ZSTD(3));

-- ── token_usage ─────────────────────────────────────────────────────────────
ALTER TABLE token_usage MODIFY COLUMN created_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1));
ALTER TABLE token_usage MODIFY COLUMN input_tokens UInt64 CODEC(T64, ZSTD(1));
ALTER TABLE token_usage MODIFY COLUMN output_tokens UInt64 CODEC(T64, ZSTD(1));
ALTER TABLE token_usage MODIFY COLUMN cached_tokens UInt64 CODEC(T64, ZSTD(1));
ALTER TABLE token_usage MODIFY COLUMN cost_usd_micros UInt64 CODEC(T64, ZSTD(1));

-- ── tool_invocations ────────────────────────────────────────────────────────
ALTER TABLE tool_invocations MODIFY COLUMN created_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1));

-- ── skill_loads ─────────────────────────────────────────────────────────────
-- created_at keeps its DEFAULT now(); only the codec is added.
ALTER TABLE skill_loads MODIFY COLUMN created_at DateTime DEFAULT now() CODEC(DoubleDelta, ZSTD(1));
-- surface is a bounded set (api/mcp/app/runner/ingestion/"") stored as plain
-- String — narrow to LowCardinality (matches token_usage/tool_invocations.surface).
ALTER TABLE skill_loads MODIFY COLUMN surface LowCardinality(String);

-- ── audit_events ────────────────────────────────────────────────────────────
ALTER TABLE audit_events MODIFY COLUMN occurred_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1));
-- trace_jsonb keeps its DEFAULT ''; sparse JSON decision log.
ALTER TABLE audit_events MODIFY COLUMN trace_jsonb String DEFAULT '' CODEC(ZSTD(3));

-- ── claude_sessions ─────────────────────────────────────────────────────────
-- inserted_at keeps its DEFAULT now(); both timestamps get the delta codec.
ALTER TABLE claude_sessions MODIFY COLUMN timestamp DateTime64(3) CODEC(DoubleDelta, ZSTD(1));
ALTER TABLE claude_sessions MODIFY COLUMN inserted_at DateTime64(3) DEFAULT now() CODEC(DoubleDelta, ZSTD(1));
-- Large text blobs.
ALTER TABLE claude_sessions MODIFY COLUMN session_prompt String DEFAULT '' CODEC(ZSTD(3));
ALTER TABLE claude_sessions MODIFY COLUMN assistant_text String DEFAULT '' CODEC(ZSTD(3));
ALTER TABLE claude_sessions MODIFY COLUMN cost_usd_micros UInt64 DEFAULT 0 CODEC(T64, ZSTD(1));
