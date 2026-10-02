-- Batch B1: the signup grant (ADR-241, #4886) and the repository heads lookup
-- index (#3340 finding 4). One Postgres migration for the batch.
--
--   1. billing.plans gains the signup grant's terms: signup_grant_gau (33,000),
--      signup_grant_days (30), and subscription_required_after_grant (true).
--      Only the Free row's values are read. seed.ts never writes these
--      columns, so an operator's UPDATE on the Free row reaches the next
--      signup with no deploy.
--   2. billing.gau_signup_grants holds one grant per organization. The unique
--      index on org_id makes the grant once-only: issueSignupGrant inserts
--      ON CONFLICT DO NOTHING. The table is org_only in the tenant policy
--      manifest, so its RLS below has the organization predicate alone.
--   3. Every existing organization on the old Free tier gets its grant from
--      the deploy date. The grant starts when this migration runs (now()) and
--      lasts the Free row's signup_grant_days, at the Free row's
--      signup_grant_gau. An organization with an entitled subscription
--      (active, trialing, past_due, or paused; ENTITLED_SUBSCRIPTION_STATUSES
--      in packages/billing/src/tier.ts) gets no grant, because it is not on
--      the Free tier and bucketBasis bills a subscriber by its subscription.
--      A database with no Free plan row yet (a fresh replay before the seed)
--      inserts nothing, and create_org grants every organization made after.
--   4. ingestion.repository_binding_heads gains an index on (provider,
--      provider_repository_id). The exclusivity trigger looks up every head
--      for one repository on each head write, under the repository's advisory
--      lock. Neither existing index serves that lookup.

ALTER TABLE billing.plans
  ADD COLUMN IF NOT EXISTS signup_grant_gau integer NOT NULL DEFAULT 33000,
  ADD COLUMN IF NOT EXISTS signup_grant_days integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS subscription_required_after_grant boolean NOT NULL DEFAULT true;
ALTER TABLE billing.plans
  ADD CONSTRAINT "plans_signup_grant_check" CHECK (signup_grant_gau >= 0 AND signup_grant_days > 0);

CREATE TABLE IF NOT EXISTS billing.gau_signup_grants (
  id uuid PRIMARY KEY DEFAULT COALESCE(CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL THEN uuid_generate_v7() ELSE uuid_generate_v4() END, uuid_generate_v4()) NOT NULL,
  org_id uuid NOT NULL REFERENCES org.organizations (id) ON DELETE CASCADE,
  granted_gau integer NOT NULL,
  granted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "gau_signup_grants_check" CHECK (granted_gau >= 0 AND expires_at > granted_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS gau_signup_grants_org_idx ON billing.gau_signup_grants (org_id);

ALTER TABLE billing.gau_signup_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.gau_signup_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.gau_signup_grants;
DROP POLICY IF EXISTS tenant_org_wide_read ON billing.gau_signup_grants;
CREATE POLICY tenant_isolation ON billing.gau_signup_grants
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- The billing schema's default privileges grant a new table on a fresh
-- replay. The explicit grant covers an environment where that default did not
-- reach it. The role guard skips a cluster with no oxagen_app.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON billing.gau_signup_grants TO oxagen_app;
  END IF;
END $$;

-- The backfill reads billing.subscriptions and writes billing.gau_signup_grants,
-- and both force row-level security. A role that applies migrations without
-- BYPASSRLS would read no subscription and have every grant refused by
-- WITH CHECK, so the block sets the policies' own bypass for its transaction
-- and clears it after.
DO $$ BEGIN
  PERFORM set_config('app.rls_bypass', 'on', true);
  INSERT INTO billing.gau_signup_grants (org_id, granted_gau, granted_at, expires_at)
  SELECT o.id, p.signup_grant_gau, now(), now() + make_interval(days => p.signup_grant_days)
  FROM org.organizations o
  CROSS JOIN billing.plans p
  WHERE p.slug = 'free'
    AND NOT EXISTS (
      SELECT 1 FROM billing.subscriptions s
      WHERE s.org_id = o.id
        AND s.status IN ('active', 'trialing', 'past_due', 'paused')
    )
  ON CONFLICT (org_id) DO NOTHING;
  PERFORM set_config('app.rls_bypass', '', true);
END $$;

CREATE INDEX IF NOT EXISTS repository_binding_heads_repository_idx ON ingestion.repository_binding_heads (provider, provider_repository_id);
