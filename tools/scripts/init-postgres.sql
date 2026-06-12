-- init-postgres.sql — extension bootstrap + atlas_dev setup.
-- Schemas are managed by Atlas (packages/database/atlas/migrations/).
-- This file runs automatically on fresh Postgres volume creation via
-- docker-entrypoint-initdb.d. For existing installations, run
-- `pnpm db:atlas-dev-setup` to re-bootstrap atlas_dev.

-- Extensions for the main oxagen database
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- uuid_generate_v7(): try pg_uuidv7 first (Postgres 17+ has it natively).
-- On Postgres 16, create a v4 stub so Atlas and migrations parse cleanly.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_uuidv7;
  EXCEPTION WHEN OTHERS THEN
    -- pg_uuidv7 not available; install a v4 stub.
    CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
    RETURNS uuid LANGUAGE sql AS $fn$ SELECT uuid_generate_v4() $fn$;
  END;
END$$;

-- NOTE: atlas_dev (the scratch database Atlas uses for `migrate diff`) is
-- deliberately NOT created here. This file also runs against MANAGED targets
-- (the CI migrate job applies it to preview/production), where the `oxagen`
-- role does not exist and CREATE DATABASE is not permitted — it previously
-- aborted the prod migrate job at `\c atlas_dev`. Local diff workflows
-- bootstrap atlas_dev via tools/scripts/atlas-dev-setup.sh
-- (`pnpm db:atlas-dev-setup`), which `pnpm db:migrate:diff` runs automatically.
