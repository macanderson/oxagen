-- init-postgres.sql — extension bootstrap only.
-- Schemas are now managed by Atlas (packages/database/atlas/migrations/).
-- Run this once before `atlas migrate apply` on any fresh Postgres instance.

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
