-- 0005_oxagen_app_role.sql
--
-- Non-superuser application role for Row-Level Security enforcement (OXA-1552).
--
-- The tenant-isolation policies in 0001_rls_policies.sql + their FORCE ROW LEVEL
-- SECURITY are only load-bearing when the application connects as a role that
-- does NOT bypass RLS. A superuser — or any role with BYPASSRLS — ignores every
-- policy unconditionally, which is why `assertRlsConnectionSafe()`
-- (packages/database/src/tenant.ts) refuses to boot the app with
-- TENANT_RLS_ENFORCEMENT_ENABLED=true on such a connection.
--
-- This migration provisions `oxagen_app`: NOSUPERUSER, NOBYPASSRLS, with USAGE
-- on every domain schema and full DML on their tables, so it can reach the data
-- but every row is still gated by the policies. It is created NOLOGIN on
-- purpose — the LOGIN password is a secret and must never live in a committed
-- migration. An operator grants LOGIN + a password out-of-band (see
-- tools/scripts/provision-rls-role.ts) and repoints DATABASE_URL at oxagen_app;
-- only then is TENANT_RLS_ENFORCEMENT_ENABLED flipped on. Until that happens the
-- role is inert (cannot connect), so applying this migration is a safe no-op for
-- the running app.
--
-- Idempotent: safe to (re-)run against any environment. Mirrors the tested role
-- setup in packages/database/integration/rls.test.ts.

SET search_path TO public;

-- 1. The role itself — create if absent, and (defensively) strip any elevated
--    attributes if it already exists, so the RLS guarantee can never be silently
--    undermined by a pre-existing role with SUPERUSER/BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    CREATE ROLE oxagen_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

ALTER ROLE oxagen_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- 2. Schema usage + table/sequence DML across all 14 domain schemas. RLS still
--    gates which rows are visible/writable; these grants only make the tables
--    reachable. Run per-schema so a future schema rename surfaces loudly here.
DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY[
    'org','auth','workspace','integration','agent','workflow',
    'event','execution','chat','content','graph','evaluation',
    'billing','security'
  ]
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO oxagen_app', s);
    -- Future objects created by the migrating role inherit these grants, so new
    -- tables/sequences don't silently become unreachable for the app role.
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxagen_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO oxagen_app', s);
  END LOOP;
END $$;

-- 3. public: schema usage + EXECUTE on functions (uuid_generate_v7(), citext
--    operators, etc.). Deliberately NO table DML here — the only public table is
--    _migrations, which belongs to the migrate runner, not the app role.
GRANT USAGE ON SCHEMA public TO oxagen_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO oxagen_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO oxagen_app;
