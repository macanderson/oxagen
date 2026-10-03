-- uuid_generate_v7() returns a time-ordered v7 id on Postgres 18 (#5395,
-- ADR-295).
--
-- Every table's id default calls public.uuid_generate_v7(). The initial schema
-- (20260611233016) made it a stub, `SELECT uuid_generate_v4()`, wherever the
-- pg_uuidv7 extension was missing, and Aurora lacks it. So every id so far is
-- a random v4.
--
-- Postgres 18 has a native uuidv7(). This makes the function call it on
-- Postgres 18 and later, and keep returning a v4 id before that. The version
-- is read when the function runs, not when this migration runs. The migration
-- runs on Aurora (Postgres 16) first. pg_dump then carries this body to
-- ClickHouse Cloud Postgres 18 at the cutover, where ids turn v7 with no
-- further migration.
--
-- PL/pgSQL, not SQL. Postgres checks a SQL function's body when the function
-- is created, so on Postgres 16 the CREATE would fail on uuidv7(), which does
-- not exist there. PL/pgSQL resolves a call only when that line runs, and on
-- Postgres 16 the uuidv7() line never runs.
--
-- Both calls name their schema, because the function runs under whatever
-- search_path the caller has.
--
-- A database where the pg_uuidv7 extension provides the function already
-- returns v7 ids, so it keeps its own.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_depend d
    WHERE d.classid = 'pg_proc'::regclass
      AND d.objid = to_regprocedure('public.uuid_generate_v7()')
      AND d.deptype = 'e'
  ) THEN
    RAISE NOTICE 'public.uuid_generate_v7() belongs to an extension; leaving it as it is';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
  RETURNS uuid
  LANGUAGE plpgsql
  VOLATILE
  AS $fn$
  BEGIN
    IF current_setting('server_version_num')::int >= 180000 THEN
      RETURN pg_catalog.uuidv7();
    END IF;
    RETURN public.uuid_generate_v4();
  END;
  $fn$;
END
$migration$;
