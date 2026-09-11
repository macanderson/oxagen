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
# ClickHouse is asked twice, because its schema arrives two ways. `db-migrate.ts`
# records each applied file in `<database>._migrations` (column `filename`), so
# one question is a set difference against
# `packages/telemetry/src/migrations/*.sql`. But `packages/telemetry/src/migrate.ts`
# also applies `schema.sql` on EVERY call, outside the ledger, and that file
# holds twelve table definitions the ledger will never mention — so the second
# question compares the tables it creates against `system.tables`. Checking only
# the ledger would call a store current while most of its tables were missing.
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

  # The name is the last whitespace-separated token of the matched prefix.
  # `awk '{ print $NF }'` reads it just as well, and cannot be used here: to a
  # scanner reading a .sh file, awk's NF is indistinguishable from an
  # environment variable, because from outside the quotes the two are the same
  # three characters. env-check flags it as an undeclared reference and is right
  # to. sed costs nothing and says the same thing.
  sed -e 's|//.*||' "$file" |
    grep -Eio '^[[:space:]]*CREATE[[:space:]]+(CONSTRAINT|(RANGE|TEXT|POINT|VECTOR|FULLTEXT)[[:space:]]+INDEX|INDEX)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' |
    sed -E 's/.*[[:space:]]//' |
    # An UNNAMED `CREATE CONSTRAINT IF NOT EXISTS FOR …` ends its matched
    # prefix on the word IF, which would enter the declared set as a constraint
    # called "IF" and report drift that can never clear. Neo4j auto-names such
    # a constraint, so there is nothing here that could ever match it anyway.
    grep -vix 'IF' |
    sort -u
}

# clickhouse_declared_tables SCHEMA_SQL
#
# Every table name `schema.sql` creates, one per line.
#
# Needed because the ledger does not cover them. packages/telemetry/src/migrate.ts
# applies schema.sql on EVERY call, outside `_migrations`, and its own comment
# says so: "schema.sql holds most, but not all, table definitions … Treat
# schema.sql plus migrations/ together as the desired state." So a store with a
# complete ledger and none of those twelve tables would answer this check
# "current" — the false green that would make the whole thing decorative.
clickhouse_declared_tables() {
  local file=$1

  if [[ ! -f $file ]]; then
    echo "clickhouse_declared_tables: no such file: $file" >&2
    return 2
  fi

  sed -e 's|--.*||' "$file" |
    grep -Eio '^[[:space:]]*CREATE[[:space:]]+TABLE[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?[A-Za-z_][A-Za-z0-9_.]*' |
    sed -E 's/.*[[:space:]]//' |
    sed 's/^.*\.//' |
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

# bump_status NEW
#
# Raises `status` without ever lowering it, and lets 2 dominate 1.
#
# The obvious `|| status=1` at each call site is wrong in a way that matters:
# ClickHouse unreadable (2) followed by Neo4j behind (1) would have overwritten
# the 2, exited 1, and reported "a store is behind" while saying nothing about
# the store nobody could read. Unknown outranks behind, because the response to
# each is different.
bump_status() {
  local new=$1
  [[ $status -eq 2 ]] && return 0
  [[ $new -gt $status ]] && status=$new
  return 0
}

# require_declarations LABEL FILE
#
# An empty DECLARED list is a check that did not happen, never a pass.
#
# The script is careful that a store answering nothing means "behind"; without
# this it was careless in the mirror image. A renamed directory would leave the
# declared list empty, every store would compare current, the run would exit 0
# and it would CLOSE the open drift issue — an active claim of recovery off no
# answer. The tests guard the paths, but they hold their own copies of them, so
# only a runtime invariant catches a rename in the script itself.
require_declarations() {
  local label=$1 file=$2
  [[ $(count_names "$file") -gt 0 ]] && return 0
  echo "::error::$label: nothing is declared, so there is nothing to compare."
  echo "::error::$label: this is a broken check, not a clean store — see #1370."
  bump_status 2
  return 1
}

# ch_missing_object OUT ERR
#
# True when the failure was "no such table/database" rather than a failure to
# reach the store. Both files are searched, for the reason above.
ch_missing_object() {
  grep -qiE 'UNKNOWN_TABLE|UNKNOWN_DATABASE|does not exist|doesn.t exist' "$1" "$2"
}

# ch_url_readonly URL
#
# The ClickHouse endpoint with `readonly=1` on it.
#
# Read-only is ENFORCED here rather than asserted about the source. The test
# used to check this by grepping the script for `INSERT INTO`, which would have
# missed `ALTER TABLE … DELETE`, `TRUNCATE`, `DROP` and `OPTIMIZE`, and which
# tests the text rather than what the server is allowed to do. With this on,
# ClickHouse refuses any write regardless of what a future edit sends.
#
# The separator is chosen rather than assumed: the endpoint may already carry a
# query string, and a second `?` makes the setting part of the path instead.
ch_url_readonly() {
  local url=$1
  case "$url" in
    *\?*) printf '%s&readonly=1\n' "$url" ;;
    *)    printf '%s?readonly=1\n' "$url" ;;
  esac
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

# ch_query BODY OUT ERR
#
# POSTs BODY to ClickHouse. Credentials go in on stdin rather than in argv, so
# they are not visible in the process table.
#
# Both streams are captured because they carry different halves of the answer:
# `--fail-with-body` sends the SERVER's error body to STDOUT and only curl's own
# generic line ("curl: (22) … returned error: 404") to stderr. Classifying a
# remote error by grepping stderr therefore never matches, which is how the one
# state this check exists for read as "could not be queried".
ch_query() {
  local body=$1 out=$2 err=$3
  printf 'user = "%s"\npassword = "%s"\n' \
    "$CLICKHOUSE_USERNAME" "$CLICKHOUSE_PASSWORD" |
    curl -sS --fail-with-body --max-time 30 --config - \
      "$(ch_url_readonly "$CLICKHOUSE_URL")" --data-binary "$body" > "$out" 2>"$err"
}

# --- ClickHouse: the migration ledger ---------------------------------------

echo "== ClickHouse migrations =="
# A glob rather than `ls | xargs basename`, so a filename with a space could
# not silently split into two migrations that neither exist nor are missing.
: > "$WORK/ch-declared.txt"
for f in "$REPO"/packages/telemetry/src/migrations/*.sql; do
  [[ -e $f ]] || continue
  basename "$f" >> "$WORK/ch-declared.txt"
done

ch_reachable=1
if require_declarations "ClickHouse migrations" "$WORK/ch-declared.txt"; then
  if ch_query "SELECT DISTINCT filename FROM ${CLICKHOUSE_DATABASE}._migrations ORDER BY filename" \
       "$WORK/ch-present.txt" "$WORK/ch-err.txt"; then
    :
  elif ch_missing_object "$WORK/ch-err.txt" "$WORK/ch-present.txt"; then
    echo "  no _migrations ledger — this store has never been migrated."
    : > "$WORK/ch-present.txt"
  else
    echo "::error::ClickHouse could not be queried. The store's state is unknown, which is not the same as current."
    # The server's own exception is on stdout; curl's line is on stderr. Both,
    # because whichever one explains it varies with how the request failed.
    cat "$WORK/ch-present.txt" "$WORK/ch-err.txt" 2>/dev/null |
      sed 's/^/::error::  /' | head -5
    bump_status 2
    ch_reachable=0
    : > "$WORK/ch-present.txt"
  fi

  if [[ $ch_reachable -eq 1 ]]; then
    report_drift "ClickHouse migrations" "$WORK/ch-declared.txt" "$WORK/ch-present.txt"
    bump_status $?
  fi
fi

# --- ClickHouse: the tables schema.sql creates outside the ledger -----------

echo
echo "== ClickHouse tables =="
clickhouse_declared_tables "$REPO/packages/telemetry/src/schema.sql" \
  > "$WORK/ch-tables-declared.txt" || bump_status 2

if [[ $ch_reachable -eq 1 ]] && require_declarations "ClickHouse tables" "$WORK/ch-tables-declared.txt"; then
  if ch_query "SELECT name FROM system.tables WHERE database = '${CLICKHOUSE_DATABASE}' ORDER BY name" \
       "$WORK/ch-tables-present.txt" "$WORK/ch-tables-err.txt"; then
    report_drift "ClickHouse tables" "$WORK/ch-tables-declared.txt" "$WORK/ch-tables-present.txt"
    bump_status $?
  else
    # system.tables always exists, so a failure here is a failure to reach the
    # store rather than an empty database — an empty database returns no rows.
    echo "::error::ClickHouse system.tables could not be read. The store's state is unknown."
    cat "$WORK/ch-tables-present.txt" "$WORK/ch-tables-err.txt" 2>/dev/null |
      sed 's/^/::error::  /' | head -5
    bump_status 2
  fi
fi

# --- Neo4j -----------------------------------------------------------------

echo
echo "== Neo4j =="
neo4j_declared_names "$REPO/packages/ontology/src/schema.cypher" \
  > "$WORK/neo-declared.txt" || bump_status 2

# Credentials come from the environment rather than -u/-p, so they stay out of
# the process table; cypher-shell reads NEO4J_USERNAME and NEO4J_PASSWORD
# itself, and both are already exported by the caller.
#
# TWO statements, not one. A SHOW cannot be a branch of a set-union in Cypher:
# Neo4j 5.24 answers the combined form with
# `Neo.ClientError.Statement.SyntaxError: Invalid input 'UNION'`. Joined into a
# single statement this check could never succeed at all, and the job would have
# been permanently red on "could not be read" — the state that teaches people to
# stop reading it.
neo_cypher() {
  cypher-shell -a "$NEO4J_URI" --format plain --non-interactive "$1"
}

if ! command -v cypher-shell >/dev/null 2>&1; then
  echo "::error::cypher-shell is not installed, so Neo4j was not checked."
  echo "::error::A skipped store must not read as a passing one — see #1370."
  bump_status 2
elif require_declarations "Neo4j" "$WORK/neo-declared.txt"; then
  if neo_cypher "SHOW CONSTRAINTS YIELD name RETURN name" \
       > "$WORK/neo-c.txt" 2>"$WORK/neo-err.txt" &&
     neo_cypher "SHOW INDEXES YIELD name RETURN name" \
       > "$WORK/neo-i.txt" 2>>"$WORK/neo-err.txt"; then
    # Each result carries a `name` header line, dropped here. A constraint's
    # backing index repeats the constraint's name; sort -u absorbs that.
    { tail -n +2 "$WORK/neo-c.txt"; tail -n +2 "$WORK/neo-i.txt"; } |
      tr -d '"' | sed '/^$/d' | sort -u > "$WORK/neo-present.txt"
    report_drift "Neo4j" "$WORK/neo-declared.txt" "$WORK/neo-present.txt"
    bump_status $?
  else
    echo "::error::Neo4j could not be queried. The store's state is unknown, which is not the same as current."
    sed 's/^/::error::  /' "$WORK/neo-err.txt" | head -5
    bump_status 2
  fi
fi

echo
case $status in
  0) echo "Both stores carry the schema this repository declares." ;;
  1) echo "::error::At least one store is behind. A schema change has merged and not reached production." ;;
  *) echo "::error::The check did not complete, so nothing here says the stores are current." ;;
esac
exit $status
