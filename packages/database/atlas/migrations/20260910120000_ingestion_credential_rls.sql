-- Row-level security for the three ingestion credential child tables.
--
-- ingestion.auth_credentials, ingestion.oauth_tokens and
-- ingestion.webhook_subscriptions were created by drizzle/0001_ingestion_core.sql
-- and never received ENABLE / FORCE / CREATE POLICY in either migration folder.
-- 0029_ingestion_rls.sql policied their parent and recorded the reason they were
-- skipped: "their isolation is transitive through source_connections". Postgres
-- RLS is not transitive. A policy on a parent constrains queries that name the
-- parent; a query naming ingestion.oauth_tokens alone evaluates only that
-- relation's policies, and there were none — so a tenant-scoped session could
-- read every org's encrypted OAuth access and refresh tokens.
--
-- WHY NOT THE BYPASS-ONLY SHAPE (ratelimit.rate_limit_counters, cms.*): three
-- live paths read and write these tables inside withTenantDb, where
-- app.rls_bypass is off, so a bypass-only policy would not fail closed — it
-- would fail wrong:
--   • packages/handlers/src/connection.create.ts   INSERT auth_credentials
--   • packages/handlers/src/connection.preview.ts  SELECT auth_credentials
--   • packages/inngest-functions/src/functions/ingestion.delete.ts
--       DELETE webhook_subscriptions + auth_credentials
-- The DELETE is the dangerous one: it would match zero rows and report success,
-- leaving a deleted connection's credentials in the table forever.
--
-- The predicate below makes the transitivity real instead of assumed. Postgres
-- evaluates the parent's own policies inside a policy subquery — that recursion
-- is why "infinite recursion detected in policy for relation" exists as an
-- error — so a child row passes exactly when its source_connections parent is
-- visible in the current scope. The four tenant paths above keep working
-- unchanged, and an unjoined read stops returning other tenants' rows.
--
-- No POLICY_MANIFEST entry: none of the three carries an org_id or a scoping
-- workspace_id, which is what the manifest classes key on, and
-- integration/manifest-coverage.test.ts only asks about tables that do.
-- integration/ingestion-credential-rls.test.ts is what holds this migration in
-- place instead.
--
-- connection_id is the primary key on auth_credentials and oauth_tokens and is
-- indexed on webhook_subscriptions, so the EXISTS lookup is an index probe.

-- ── ingestion.auth_credentials ───────────────────────────────────────────────
ALTER TABLE ingestion.auth_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.auth_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.auth_credentials;
CREATE POLICY tenant_isolation ON ingestion.auth_credentials
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM ingestion.source_connections sc
      WHERE sc.id = auth_credentials.connection_id
    )
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM ingestion.source_connections sc
      WHERE sc.id = auth_credentials.connection_id
    )
  );

-- ── ingestion.oauth_tokens ───────────────────────────────────────────────────
ALTER TABLE ingestion.oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.oauth_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.oauth_tokens;
CREATE POLICY tenant_isolation ON ingestion.oauth_tokens
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM ingestion.source_connections sc
      WHERE sc.id = oauth_tokens.connection_id
    )
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM ingestion.source_connections sc
      WHERE sc.id = oauth_tokens.connection_id
    )
  );

-- ── ingestion.webhook_subscriptions ──────────────────────────────────────────
ALTER TABLE ingestion.webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.webhook_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.webhook_subscriptions;
CREATE POLICY tenant_isolation ON ingestion.webhook_subscriptions
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM ingestion.source_connections sc
      WHERE sc.id = webhook_subscriptions.connection_id
    )
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR EXISTS (
      SELECT 1 FROM ingestion.source_connections sc
      WHERE sc.id = webhook_subscriptions.connection_id
    )
  );

-- ────────────────────────────────────────────────────────────────────────────
-- The policy subquery reads ingestion.source_connections as the invoking role,
-- so oxagen_app needs SELECT on the parent to satisfy a policy on the child.
-- 0029_ingestion_rls.sql already granted it schema-wide; this is the guarded
-- re-assertion the rest of the migration folder uses, and a no-op where it
-- already holds.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT USAGE ON SCHEMA ingestion TO oxagen_app;
    GRANT SELECT ON ingestion.source_connections TO oxagen_app;
  END IF;
END
$$;
