-- tacho.gateway_invocations — which of a host's chains the control plane was
-- actually serving when it authorised a gateway call (#3221).
--
-- 20260917140000 gave the enforcement tier a server-owned foundation:
-- `hosts.gateway_last_seen_at`, stamped where Oxagen authenticates a
-- server-minted `tacho_gateway_v1` credential. That fixed *whether* a host had
-- served a gateway call. It could not fix *which session* had, because it is a
-- single timestamp with no session on it — so ingest still read
-- `oxagen.enforcement_tier` off the submitted batch to decide that half.
--
-- Whoever can submit a batch chooses that attribute. Once a host had served
-- one legitimate gateway call, a holder of its control-plane key could point
-- the observation at any session, including one invented in the same batch
-- (`genesisRow` passes no lifetime, so nothing predates it). The promotion is
-- monotonic and the replay grade is signed carrying it.
--
-- Each row here is the control plane's own record of one authorised call and
-- the daemon chain the caller named on the request. The chain id is named by
-- the caller — but the caller is authenticated as the holder of the gateway
-- credential, which never leaves the daemon, and a batch submitter cannot
-- cause a row to exist at all.
--
-- Plain DDL only (RDS-compatible); no cross-schema FK, app-enforced per
-- CLAUDE.md; RLS follows the tenant_isolation pattern from 20260612140000.
CREATE TABLE IF NOT EXISTS "tacho"."gateway_invocations" (
	"id" uuid PRIMARY KEY DEFAULT COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
) NOT NULL,
	"public_id" "citext" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"chain_session_uuid" text NOT NULL,
	"capability_name" text NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "tacho_gateway_invocations_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "tacho_gateway_invocations_outcome_check" CHECK ("outcome" IN ('allowed', 'refused'))
);

-- The read ingest makes, and the only one: this host's invocations for the
-- chains a batch names. `created_at` is in the index because the match is
-- bounded to the session's lifetime, so the range is scanned, not filtered.
CREATE INDEX IF NOT EXISTS "tacho_gateway_invocations_chain_idx"
  ON "tacho"."gateway_invocations" USING btree ("host_id","chain_session_uuid","created_at");

-- ── RLS — tenant_isolation ────────────────────────────────────────────────────
ALTER TABLE tacho.gateway_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tacho.gateway_invocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tacho.gateway_invocations;
CREATE POLICY tenant_isolation ON tacho.gateway_invocations
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ── oxagen_app grants ─────────────────────────────────────────────────────────
-- SELECT and INSERT only. A row is a record of something that happened; there
-- is nothing to correct in it, and in particular ingest does NOT consume one on
-- match. Consuming would let a forged batch that arrived first burn a real
-- observation belonging to the session that earned it — which trades this
-- defect for a worse one, the reason #3178 declined to narrow the window
-- instead of fixing the correlation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA tacho TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT ON tacho.gateway_invocations TO oxagen_app';
  END IF;
END
$$;
