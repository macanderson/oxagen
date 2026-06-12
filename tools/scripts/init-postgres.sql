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

-- atlas_dev: scratch database Atlas uses for migration diff computation.
-- Needs the same extensions as the main database, or diff fails on citext/uuidv7.
CREATE DATABASE atlas_dev OWNER oxagen;
\c atlas_dev
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_uuidv7;
  EXCEPTION WHEN OTHERS THEN
    CREATE OR REPLACE FUNCTION public.uuid_generate_v7()
    RETURNS uuid LANGUAGE sql AS $fn$ SELECT uuid_generate_v4() $fn$;
  END;
END$$;
