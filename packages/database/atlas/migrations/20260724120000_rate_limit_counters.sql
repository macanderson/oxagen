-- ratelimit schema — distributed API rate-limit counters.
--
-- Backs the Postgres-store fixed-window limiter mounted on the chat + agent-
-- execution surfaces (apps/api/src/middleware/distributed-rate-limit.ts).
-- Postgres is the store because it is the only shared, transactional store in
-- the stack; vendor-neutrality is a core moat, so we deliberately do NOT add
-- Redis/Upstash. Better Auth already keeps its own `rate_limit` counters in
-- Postgres (auth.rate_limit), so this follows an established in-repo precedent.
--
-- DELIBERATE DEVIATION from the standard uuid id + public_id + audit-mixin SQL
-- convention: this is a hot, ephemeral counter, not a domain entity. The
-- natural composite key (bucket_key, window_start) IS the upsert conflict
-- target for the one atomic
--     INSERT ... ON CONFLICT (bucket_key, window_start)
--       DO UPDATE SET count = count + 1 RETURNING count
-- executed once per request. A surrogate uuid id would add a second unique
-- index to maintain on every hit for zero benefit (no row ever references a
-- counter by id), and public_id / created_by / updated_at would be dead weight
-- on a row whose whole lifecycle is "increment a few times, then get swept".
-- This mirrors Better Auth's equally lean auth.rate_limit table.
--
-- NOT tenant-scoped: a counter keys on workspace OR org OR client IP, so there
-- is no single (org_id, workspace_id) it belongs to. Every access goes through
-- the audited withSystemDb bypass; the table gets a BYPASS-ONLY RLS policy
-- (USING app.rls_bypass = 'on'), exactly like the cms.* tables, so a tenant
-- query can never read another org's counters.

-- ── Schema ────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS "ratelimit";

-- ── ratelimit.rate_limit_counters ─────────────────────────────────────────────
CREATE TABLE "ratelimit"."rate_limit_counters" (
	"bucket_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("bucket_key", "window_start")
);
-- Cleanup sweep target: the limiter opportunistically deletes windows older
-- than a couple of windows (DELETE ... WHERE window_start < now() - interval).
-- A dedicated index keeps that range scan off the composite PK's leading column.
CREATE INDEX "rate_limit_counters_window_start_idx"
  ON "ratelimit"."rate_limit_counters" USING btree ("window_start");

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — bypass-only. These counters are cross-tenant system state; the sole
-- access path is withSystemDb (which sets app.rls_bypass='on'). No tenant
-- policy: a tenant-scoped query can never see another org's counters. Mirrors
-- the cms.* system tables (20260710120000_cms_ebook_lead_gate.sql).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE ratelimit.rate_limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE ratelimit.rate_limit_counters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_only ON ratelimit.rate_limit_counters;
CREATE POLICY system_only ON ratelimit.rate_limit_counters
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');

-- ────────────────────────────────────────────────────────────────────────────
-- oxagen_app least-privilege grants (guarded — fresh clusters may lack the role).
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT USAGE ON SCHEMA ratelimit TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ratelimit.rate_limit_counters TO oxagen_app;
  END IF;
END
$$;
