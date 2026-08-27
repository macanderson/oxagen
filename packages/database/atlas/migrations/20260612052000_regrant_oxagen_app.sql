-- Re-grant least-privilege access for the oxagen_app RLS role (P0 outage fix).
--
-- The Atlas baseline (20260611233016_initial_schema.sql) is generated from
-- `drizzle-kit export`, which emits ONLY the Drizzle schema — CREATE ROLE and
-- GRANT statements from the retired drizzle/0005+0006 migrations were silently
-- dropped. When prod Postgres was rebuilt from that baseline, every schema came
-- back with zero privileges for oxagen_app: the role still authenticates
-- (roles are cluster-level and survive a DB drop) but every query fails with
-- 42501 "permission denied for schema auth" — taking down the API and all app
-- auth. This migration restores the grants and must survive future rebuilds
-- because it lives in the Atlas dir that `atlas migrate apply` replays.
--
-- Grants iterate pg_namespace instead of a hardcoded schema list so schemas
-- added after this migration is written are still covered when a fresh
-- environment replays the full directory. Idempotent: GRANT and ALTER DEFAULT
-- PRIVILEGES are no-ops when already in place.

-- Role guard: fresh CI/preview databases run this directory against a cluster
-- where the role may not exist yet. NOLOGIN here; provisioning the password
-- (LOGIN) stays in tools/scripts/provision-rls-role.ts — never in a migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    CREATE ROLE oxagen_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- RLS safety invariants — re-assert only if the role's actual attributes
-- have drifted from these, never unconditionally. On RDS/Aurora the
-- connecting role is never a true Postgres superuser (only rds_superuser),
-- and Postgres gates ALTER ROLE's SUPERUSER/BYPASSRLS clauses on the
-- actor's own superuser bit regardless of the target value — so this
-- statement failed with 42501 on every RDS/Aurora target even though
-- CREATE ROLE above had already set the same safe values. Guarding it
-- keeps the repair this migration exists for (a role that pre-existed with
-- elevated privileges, fixable by an actual superuser on self-hosted
-- Postgres) while making it a true no-op everywhere the role already has
-- these defaults.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'oxagen_app'
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole)
  ) THEN
    ALTER ROLE oxagen_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

DO $$
DECLARE
  s text;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND nspname NOT LIKE 'pg_temp%'
      AND nspname NOT LIKE 'pg_toast_temp%'
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO oxagen_app', s);
    -- Future objects created by the migration-running admin role in each
    -- schema inherit the same privileges (the drizzle/0006 forward-fix).
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxagen_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO oxagen_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO oxagen_app', s);
  END LOOP;
END
$$;
