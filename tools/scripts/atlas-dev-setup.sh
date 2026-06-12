#!/usr/bin/env bash
# atlas-dev-setup.sh — ensure atlas_dev scratch database exists with required extensions.
# Atlas uses atlas_dev for migration diff computation; it needs citext + uuid-ossp to
# process our schema DDL. Run this before `atlas migrate diff`.
#
# Safe to run multiple times — all operations are idempotent.

set -euo pipefail

PG_HOST="${PGHOST:-localhost}"
PG_PORT="${PGPORT:-5433}"
PG_USER="${PGUSER:-oxagen}"
PG_PASS="${PGPASSWORD:-oxagen}"

PSQL="psql -h $PG_HOST -p $PG_PORT -U $PG_USER"

echo "→ Ensuring atlas_dev database exists..."
PGPASSWORD="$PG_PASS" $PSQL -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname = 'atlas_dev'" \
  | grep -q 1 \
  || PGPASSWORD="$PG_PASS" $PSQL -d postgres -c "CREATE DATABASE atlas_dev OWNER $PG_USER"

echo "→ Installing extensions in atlas_dev..."
PGPASSWORD="$PG_PASS" $PSQL -d atlas_dev <<'SQL'
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
SQL

echo "✓ atlas_dev is ready"
