#!/usr/bin/env bash
#
# Does production ClickHouse and Neo4j carry the schema this repository declares?
#
#   infra/tools/check-store-drift.sh
#
# Exits 0 when both stores are current, 1 when either is behind, 2 when the
# check could not be made. Reads only — it never applies anything. Applying is
# `.github/workflows/store-migrate.yml`, which is deliberately a manual dispatch
# with a human reading the pending list first.
#
# WHY THIS EXISTS (#1370)
#
# A ClickHouse or Neo4j schema change merges green and reaches no database. The
# `test` and `e2e` jobs both run `db-migrate.ts` against their own ephemeral
# service containers, so the migrations are known to *apply* — they are proven
# on every PR. What nothing proved is that they were applied to the store the
# platform actually uses. Postgres has `atlas migrate status` and a revision
# table to answer that question; these two had no equivalent and no caller.
#
# What that cost, already: production ClickHouse carried no schema at all from
# the 2026-08-27 cutover onward. The API's error sink failed on every capture
# with `Table oxagen.error_events does not exist`, and nothing reported it,
# because a failing error reporter is the one component whose failure it cannot
# report. That is the silent-failure shape this turns into a red run.
#
# HOW EACH STORE IS ASKED
#
# ClickHouse keeps a ledger. `db-migrate.ts` records each applied file in
# `<database>._migrations` (column `filename`), so the question is a set
# difference against `packages/telemetry/src/migrations/*.sql`.
#
# Neo4j keeps none — its migration is idempotent `CREATE ... IF NOT EXISTS` and
# forgets what it did. But every constraint and index in `schema.cypher` is
# NAMED, and `SHOW CONSTRAINTS` / `SHOW INDEXES` return those names, so the same
# set difference works on names instead of filenames. That is narrower than the
# ClickHouse check: it sees a constraint or index that never landed, and not a
# relabel or a backfill step, which leave no name behind. Narrower and true
# beats broad and guessed, and the constraints are where a missed migration
# actually bites.
#
# The connection details come from the environment, which is how the workflow
# hands over what it read from Parameter Store:
#
#   CLICKHOUSE_URL CLICKHOUSE_USERNAME CLICKHOUSE_PASSWORD CLICKHOUSE_DATABASE
#   NEO4J_URI NEO4J_USERNAME NEO4J_PASSWORD
#
# Nothing here prints a credential. The failure messages name files and
# constraints.

# ---------------------------------------------------------------------------
# The pure half — a set difference, and how it is reported.
#
# These take files rather than a connection so the test can drive them without
# a database, which is the same reason render_remote_migration in
# run-db-migrations.sh sits above its own source guard. The whole value of this
# script is in what it concludes from two lists, and that is exactly the part a
# live run is worst at exercising: a store that happens to be current proves
# nothing about what the check does when it is not.
# ---------------------------------------------------------------------------

# missing_from DECLARED_FILE PRESENT_FILE
#
# Lines in DECLARED that are not in PRESENT, one per line, on stdout.
# Returns 0 when nothing is missing, 1 when something is.
#
# Both inputs are sorted here rather than trusted to arrive sorted: `comm`
# silently produces nonsense on unsorted input, and it is a store's schema that
# would be misreported.
missing_from() {
  local declared=$1 present=$2

  if [[ ! -f $declared ]]; then
    echo "missing_from: no such file: $declared" >&2
    return 2
  fi
  # An absent PRESENT file is a store that answered nothing, not a store that
  # is current. Treated as empty, so everything declared reads as missing.
  [[ -f $present ]] || present=/dev/null

  local out
  out=$(comm -23 <(sort -u "$declared") <(sort -u "$present"))

  [[ -z $out ]] && return 0
  printf '%s\n' "$out"
  return 1
}

# neo4j_declared_names SCHEMA_CYPHER
#
# The name of every constraint and index the schema file declares, one per line.
#
# Matches `CREATE CONSTRAINT <name>` and `CREATE [RANGE|TEXT|POINT|VECTOR|
# FULLTEXT] INDEX <name>`, in both cases only where a name is actually given —
# an unnamed index gets an auto-generated name in Neo4j that this could never
# match, so including it would report permanent false drift.
#
# Commented lines are dropped first, for the same reason splitStatements does it
# in packages/ontology/src/migrate.ts: a commented-out constraint is not
# declared, and a check that thinks it is would be red forever.
neo4j_declared_names() {
  local file=$1

  if [[ ! -f $file ]]; then
    echo "neo4j_declared_names: no such file: $file" >&2
    return 2
  fi

  sed -e 's|//.*||' "$file" |
    grep -Eio '^[[:space:]]*CREATE[[:space:]]+(CONSTRAINT|(RANGE|TEXT|POINT|VECTOR|FULLTEXT)[[:space:]]+INDEX|INDEX)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' |
    awk '{ print $NF }' |
    sort -u
}

# count_names FILE
#
# How many distinct non-empty lines FILE holds; 0 for an absent or empty file.
#
# Its own function because the obvious inline version is wrong in the one case
# that matters most. `grep -c .` prints 0 AND exits 1 on an empty file, so
# `$(... | grep -c . || echo 0)` emits "0" twice and the verdict reads
# "0\n0 present" — mangling precisely the line someone pastes into an incident,
# for precisely the state production ClickHouse was in from the 2026-08-27
# cutover: a ledger that exists and is empty.
count_names() {
  local file=$1
  [[ -f $file ]] || { echo 0; return 0; }
  sort -u "$file" | grep -c . || true
}

# report_drift STORE DECLARED_FILE PRESENT_FILE
#
# Prints a verdict a person can act on and returns 0 (current) or 1 (behind).
# The message names the store, counts both sides, and lists what is missing —
# a bare "drift detected" sends the reader back to the same two queries this
# just ran.
report_drift() {
  local store=$1 declared=$2 present=$3
  local missing rc

  missing=$(missing_from "$declared" "$present")
  rc=$?

  if [[ $rc -eq 2 ]]; then
    echo "::error::$store: could not be compared — see the message above."
    return 2
  fi

  local n_declared n_present
  n_declared=$(count_names "$declared")
  n_present=$(count_names "$present")

  if [[ $rc -eq 0 ]]; then
    echo "$store: current — $n_declared declared, $n_present present."
    return 0
  fi

  echo "::error::$store is behind this repository: $n_declared declared, $n_present present."
  printf '%s\n' "$missing" | sed 's/^/::error::  missing: /'
  echo "::error::$store: apply with the Store Migrate (manual) workflow — read its pending list first."
  return 1
}

# ---------------------------------------------------------------------------
# Sourcing stops here. Below this line the script talks to two databases.
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0
fi

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/store-drift-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

: "${CLICKHOUSE_URL:?CLICKHOUSE_URL must be set}"
: "${CLICKHOUSE_USERNAME:?CLICKHOUSE_USERNAME must be set}"
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD must be set}"
: "${CLICKHOUSE_DATABASE:?CLICKHOUSE_DATABASE must be set}"
: "${NEO4J_URI:?NEO4J_URI must be set}"
: "${NEO4J_USERNAME:?NEO4J_USERNAME must be set}"
: "${NEO4J_PASSWORD:?NEO4J_PASSWORD must be set}"

status=0

# --- ClickHouse ------------------------------------------------------------

echo "== ClickHouse =="
ls "$REPO"/packages/telemetry/src/migrations/*.sql |
  xargs -n1 basename > "$WORK/ch-declared.txt"

# A query that fails and a store with no ledger are different answers and must
# not collapse into one. No ledger means never migrated, which is drift; a
# failed query means the check did not happen, which is not a verdict.
ch_body="SELECT DISTINCT filename FROM ${CLICKHOUSE_DATABASE}._migrations ORDER BY filename"
if curl -sS --fail-with-body --max-time 30 \
     --user "$CLICKHOUSE_USERNAME:$CLICKHOUSE_PASSWORD" \
     "$CLICKHOUSE_URL" --data-binary "$ch_body" > "$WORK/ch-present.txt" 2>"$WORK/ch-err.txt"; then
  :
elif grep -qiE 'UNKNOWN_TABLE|does not exist|Table .* doesn.t exist' "$WORK/ch-err.txt"; then
  echo "  no _migrations ledger — this store has never been migrated."
  : > "$WORK/ch-present.txt"
else
  echo "::error::ClickHouse could not be queried. The store's state is unknown, which is not the same as current."
  sed 's/^/::error::  /' "$WORK/ch-err.txt" | head -5
  status=2
  : > "$WORK/ch-present.txt"
fi

if [[ $status -ne 2 ]]; then
  report_drift "ClickHouse" "$WORK/ch-declared.txt" "$WORK/ch-present.txt" || status=1
fi

# --- Neo4j -----------------------------------------------------------------

echo
echo "== Neo4j =="
neo4j_declared_names "$REPO/packages/ontology/src/schema.cypher" > "$WORK/neo-declared.txt"

# cypher-shell over the same forwarded port the workflow opened. `--format
# plain` with a bare name column gives one name per line and a header, which is
# dropped below.
if command -v cypher-shell >/dev/null 2>&1; then
  if cypher-shell -a "$NEO4J_URI" -u "$NEO4J_USERNAME" -p "$NEO4J_PASSWORD" \
       --format plain --non-interactive \
       "SHOW CONSTRAINTS YIELD name RETURN name UNION ALL SHOW INDEXES YIELD name RETURN name" \
       > "$WORK/neo-raw.txt" 2>"$WORK/neo-err.txt"; then
    # Drop the `name` header and any quoting cypher-shell adds.
    tail -n +2 "$WORK/neo-raw.txt" | tr -d '"' | sed '/^$/d' | sort -u > "$WORK/neo-present.txt"
    report_drift "Neo4j" "$WORK/neo-declared.txt" "$WORK/neo-present.txt" || status=1
  else
    echo "::error::Neo4j could not be queried. The store's state is unknown, which is not the same as current."
    sed 's/^/::error::  /' "$WORK/neo-err.txt" | head -5
    status=2
  fi
else
  echo "::error::cypher-shell is not installed, so Neo4j was not checked."
  echo "::error::A skipped store must not read as a passing one — see #1370."
  status=2
fi

echo
case $status in
  0) echo "Both stores carry the schema this repository declares." ;;
  1) echo "::error::At least one store is behind. A schema change has merged and not reached production." ;;
  *) echo "::error::The check did not complete, so nothing here says the stores are current." ;;
esac
exit $status
