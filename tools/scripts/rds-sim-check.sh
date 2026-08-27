#!/usr/bin/env bash
#
# Apply the Atlas directory as a role that cannot do what RDS/Aurora cannot do.
#
# Every Postgres container in this pipeline runs as a real superuser, and RDS
# never gives you one — the master user gets `rds_superuser`, which is not the
# same bit. So the whole class of migration that only works as a superuser is
# invisible to CI by construction, and is found by a human running the directory
# against a real cluster, once, after the fact.
#
# That is not theoretical. #1333 fixed two migrations that had been on `main`
# for months and passed CI every time:
#
#   20260612052000_regrant_oxagen_app.sql          ALTER ROLE ... NOBYPASSRLS
#   20260813110000_agent_run_authorization_...sql  CREATE FUNCTION ... SET <guc>
#
# Both failed 42501 the first time the directory met Aurora, and the first one
# wedged it at file 3 of 88. Both are caught here.
#
# WHAT THIS DOES NOT COVER: extension availability. RDS ships an allowlist, and
# this bootstraps the same extensions the other jobs do. A migration needing an
# extension RDS does not carry still passes here. Catching that needs a real
# cluster, which is #1341/#1275 territory, not this script's.
#
# The connection pieces are passed in rather than parsed out of a URL: this runs
# in a container image whose contents are defined elsewhere, and a URL parser is
# one more thing that has to be present. String concatenation needs nothing.
#
# Usage:
#   PGHOST=postgres PGPORT=5432 PGSUPERUSER=oxagen PGSUPERPASS=oxagen \
#     ./tools/scripts/rds-sim-check.sh
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
: "${PGSUPERUSER:?PGSUPERUSER must name a superuser on the cluster}"
: "${PGSUPERPASS:?PGSUPERPASS must hold the password for that superuser}"
PGSUPERDB="${PGSUPERDB:-postgres}"

SIM_DB="${SIM_DB:-oxagen_rds_sim}"
SIM_ROLE="${SIM_ROLE:-rds_sim}"
SIM_PW="${SIM_PW:-rds_sim}"
SSLMODE="${SSLMODE:-disable}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-packages/database/atlas/migrations}"

url() { # url <user> <password> <database>
  printf 'postgres://%s:%s@%s:%s/%s?sslmode=%s' \
    "$1" "$2" "$PGHOST" "$PGPORT" "$3" "$SSLMODE"
}

SUPERUSER_URL="$(url "$PGSUPERUSER" "$PGSUPERPASS" "$PGSUPERDB")"
SUPER_ON_SIM="$(url "$PGSUPERUSER" "$PGSUPERPASS" "$SIM_DB")"
SIM_URL="$(url "$SIM_ROLE" "$SIM_PW" "$SIM_DB")"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# The role. rds_superuser can create roles and databases and install allowlisted
# extensions; it is NOT a Postgres superuser and cannot be granted BYPASSRLS.
# ---------------------------------------------------------------------------
say "Creating the RDS-like role and a fresh database"
psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -q <<SQL
DROP DATABASE IF EXISTS ${SIM_DB};
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SIM_ROLE}') THEN
    CREATE ROLE ${SIM_ROLE} LOGIN PASSWORD '${SIM_PW}';
  END IF;
END
\$\$;
ALTER ROLE ${SIM_ROLE} NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE;
CREATE DATABASE ${SIM_DB} OWNER ${SIM_ROLE};
SQL

# Extensions are installed by the superuser, exactly as RDS pre-provisions or
# rds_superuser installs from the allowlist. This is the one place the sim is
# deliberately more permissive than the role under test.
say "Bootstrapping extensions as superuser"
psql "$SUPER_ON_SIM" -v ON_ERROR_STOP=1 -q -f tools/scripts/init-postgres.sql

# On RDS **one role does everything**: the master user runs CREATE EXTENSION and
# then runs the migrations, so it owns the extensions, their member functions,
# and anything else the bootstrap left behind. Only the superuser bit is missing.
#
# Reproducing that is the whole trick, and getting it wrong produces failures
# that say nothing about Aurora. Two such, both seen on this branch before this
# block existed:
#
#   file 1/88   must be owner of function uuid_generate_v7
#               (bootstrap left a plain SQL function owned by the superuser; the
#                baseline re-runs the same block as the sim role)
#   file 3/88   permission denied for function pg_stat_statements_reset
#               (the regrant migration does GRANT EXECUTE ON ALL FUNCTIONS IN
#                SCHEMA public, and you cannot grant on what you do not own)
#
# Neither is an Aurora finding — on Aurora the master user owns both — and a
# harness that fails for its own reasons teaches the next reader to ignore it.
#
# So: hand the whole database to the sim role, extension members included. What
# stays behind is exactly the one thing RDS withholds, which is the point.
say "Handing the database to ${SIM_ROLE}, as RDS gives it to the master user"
psql "$SUPER_ON_SIM" -v ON_ERROR_STOP=1 -q <<SQL
GRANT ALL ON SCHEMA public TO ${SIM_ROLE};
ALTER SCHEMA public OWNER TO ${SIM_ROLE};
DO \$\$
DECLARE obj record;
BEGIN
  FOR obj IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO ${SIM_ROLE}', obj.sig);
  END LOOP;

  FOR obj IN
    SELECT c.oid::regclass::text AS rel
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'S')
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO ${SIM_ROLE}', obj.rel);
  END LOOP;

  FOR obj IN
    SELECT t.oid::regtype::text AS typ
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typtype = 'd'
  LOOP
    EXECUTE format('ALTER DOMAIN %s OWNER TO ${SIM_ROLE}', obj.typ);
  END LOOP;
END
\$\$;
SQL

# ---------------------------------------------------------------------------
# Prove the harness can still fail.
#
# A restriction that stopped restricting would make this job green forever while
# checking nothing — the exact shape of the bug it exists to catch. So before
# trusting a pass on the real directory, assert the sim role is genuinely
# refused the two constructions that broke Aurora. If either SUCCEEDS, the
# harness is broken and says so, rather than reporting a clean run.
# ---------------------------------------------------------------------------
say "Self-test: the sim role must be refused what RDS refuses"

assert_refused() {
  local label="$1" sql="$2" out rc
  set +e
  out="$(psql "$SIM_URL" -v ON_ERROR_STOP=1 -q -c "$sql" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    echo "SELF-TEST FAILED: the sim role was ALLOWED to ${label}."
    echo "This harness is not restricting anything, so a green run here proves"
    echo "nothing. Check that ${SIM_ROLE} is NOSUPERUSER and that no earlier"
    echo "step granted it more."
    return 1
  fi
  if ! grep -q "42501\|must be superuser\|permission denied" <<<"$out"; then
    echo "SELF-TEST INCONCLUSIVE: ${label} failed, but not on privilege:"
    echo "$out"
    return 1
  fi
  echo "  refused (as RDS would): ${label}"
}

# The two shapes #1333 fixed, reduced to their essence.
assert_refused "ALTER ROLE ... NOBYPASSRLS" \
  "ALTER ROLE ${SIM_ROLE} NOBYPASSRLS;"
assert_refused "CREATE FUNCTION ... SET <custom guc>" \
  "CREATE FUNCTION public.rds_sim_probe() RETURNS void LANGUAGE sql
     SET app.rds_sim_probe = 'on' AS \$fn\$ SELECT \$fn\$;"

# ---------------------------------------------------------------------------
# The real thing.
# ---------------------------------------------------------------------------
say "Applying all $(find "$MIGRATIONS_DIR" -name '*.sql' | wc -l | tr -d ' ') migrations as ${SIM_ROLE}"
cd packages/database
DATABASE_URL="$SIM_URL" atlas migrate apply --env ci

say "The directory applies without a superuser."
