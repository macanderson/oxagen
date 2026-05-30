-- 0003_rename_tenant_to_org.sql
--
-- Wave-1 IAM, Phase 1: purge "tenant" terminology from the Postgres schema.
-- The schema becomes `org`, the table `organizations`, the column `org_id`.
-- No view aliases, no compatibility shims (per locked product decision —
-- docs/architecture/iam/plan.md Phase 1).
--
-- Renames preserve table/column OIDs, so Postgres rewrites every foreign-key
-- and index reference automatically — no data is moved. Public-id values on
-- existing rows keep their historical `ten_`/`tnu_` prefixes (the prefix only
-- governs newly-generated ids); the app now mints `org_`/`oru_`.
--
-- Down migration (documented, not run):
--   ALTER SCHEMA org RENAME TO organization;
--   ALTER TABLE organization.organizations   RENAME TO tenants;
--   ALTER TABLE organization.org_users        RENAME TO tenant_users;
--   ALTER TABLE organization.org_slug_history RENAME TO tenant_slug_history;
--   ...then reverse every org_id -> tenant_id column rename and *_org_* index
--   rename via the inverse of the loops below.

DO $$
DECLARE
  r record;
BEGIN
  -- 1. Schema rename. Guard so a partial re-run is a no-op.
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'organization') THEN
    EXECUTE 'ALTER SCHEMA organization RENAME TO org';
  END IF;

  -- 2. Table renames within the org schema.
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'org' AND table_name = 'tenants') THEN
    EXECUTE 'ALTER TABLE org.tenants RENAME TO organizations';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'org' AND table_name = 'tenant_users') THEN
    EXECUTE 'ALTER TABLE org.tenant_users RENAME TO org_users';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'org' AND table_name = 'tenant_slug_history') THEN
    EXECUTE 'ALTER TABLE org.tenant_slug_history RENAME TO org_slug_history';
  END IF;

  -- 3. Every `tenant_id` column, in every user schema, becomes `org_id`.
  FOR r IN
    SELECT table_schema, table_name
    FROM information_schema.columns
    WHERE column_name = 'tenant_id'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I RENAME COLUMN tenant_id TO org_id',
      r.table_schema, r.table_name
    );
  END LOOP;

  -- 4. Special-case the two indexes whose table was renamed tenants ->
  --    organizations (the generic loop below would derive `orgs_*`).
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'org' AND indexname = 'tenants_slug_idx') THEN
    EXECUTE 'ALTER INDEX org.tenants_slug_idx RENAME TO organizations_slug_idx';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'org' AND indexname = 'tenants_status_idx') THEN
    EXECUTE 'ALTER INDEX org.tenants_status_idx RENAME TO organizations_status_idx';
  END IF;

  -- 5. Every remaining index whose name mentions `tenant` is rewritten
  --    `tenant` -> `org` (handles tenant_users_* -> org_users_*,
  --    *_tenant_idx -> *_org_idx, tenant_slug_history_* -> org_slug_history_*).
  FOR r IN
    SELECT schemaname, indexname
    FROM pg_indexes
    WHERE indexname LIKE '%tenant%'
      AND schemaname NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format(
      'ALTER INDEX %I.%I RENAME TO %I',
      r.schemaname, r.indexname, replace(r.indexname, 'tenant', 'org')
    );
  END LOOP;
END $$;
