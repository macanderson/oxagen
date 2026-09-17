-- Attribution columns are named for the reference they hold, not for the
-- table they point at: `created_by_id`, `updated_by_id`, `deleted_by_id`
-- (Mission Control spec App. A.0 as amended 2026-09-15; ADR-077). The old
-- `*_by_user_id` spelling was the only place in the schema where a foreign
-- key carried its target table in its name (`org_id`, `user_id`,
-- `approver_id`, `requester_id` never did), and `createdBy` is already the
-- resolved display-name projection in the role contracts, so the `_id`
-- suffix is what keeps the row column and the projection apart.
--
-- Every table that carries one of the three columns is renamed, whichever
-- schema it lives in and whichever migration created it. The rename is
-- looked up from information_schema rather than spelled out per table so
-- that a table created by a migration that merged before this one, but
-- after the list would have been written, is still covered. It is
-- idempotent: a column already renamed is not found and nothing runs.
--
-- Nothing else references these columns by name: no index, CHECK, trigger,
-- view, policy or function in the migration history names them (checked on
-- 2026-09-15 with `rg` over atlas/migrations), so RENAME COLUMN is the whole
-- change. A migration that lands after this one and still spells the old
-- names in a CREATE TABLE must be corrected before it merges —
-- `pnpm db:atlas-validate` catches the drift between the Drizzle mixins and
-- the applied schema; `tools/scripts/codemod-attribution-columns.mjs` is the
-- mechanical fix for the TypeScript side.

DO $$
DECLARE
  col record;
BEGIN
  FOR col IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE column_name IN ('created_by_user_id', 'updated_by_user_id', 'deleted_by_user_id')
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name, column_name
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I RENAME COLUMN %I TO %I',
      col.table_schema,
      col.table_name,
      col.column_name,
      replace(col.column_name, '_by_user_id', '_by_id')
    );
  END LOOP;
END $$;
