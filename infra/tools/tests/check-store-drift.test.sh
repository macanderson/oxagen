#!/usr/bin/env bash
#
# Holds the store-drift check to the one thing it is for: saying so when a
# committed ClickHouse or Neo4j migration has not reached production (#1370).
#
# Every assertion here is about what the script CONCLUDES from two lists, which
# is deliberately the part a live run exercises worst. A store that happens to
# be current proves nothing about the behaviour that matters — what it does when
# a store is behind, when a store has never been migrated at all, and when the
# query failed and the answer is unknown. Those three must not collapse into one
# another, and a real store can only ever be in one of them at a time.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOLS=$(cd "$HERE/.." && pwd)
REPO=$(cd "$TOOLS/../.." && pwd)

# Sourcing returns before the script talks to a database — see its source guard.
# shellcheck source=infra/tools/check-store-drift.sh
source "$TOOLS/check-store-drift.sh"

FAILED=0
CASES=0

pass() { CASES=$((CASES + 1)); }
fail() {
  CASES=$((CASES + 1))
  FAILED=$((FAILED + 1))
  echo "FAIL: $1" >&2
}

contains() {
  local haystack=$1 needle=$2 label=$3
  case "$haystack" in
    *"$needle"*) pass ;;
    *) fail "$label — expected to find: $needle" ;;
  esac
}

expect_code() {
  local want=$1 got=$2 label=$3
  if [[ $want == "$got" ]]; then pass; else fail "$label — wanted exit $want, got $got"; fi
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/store-drift-test-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# --- missing_from ----------------------------------------------------------

printf '0002_a.sql\n0003_b.sql\n0004_c.sql\n' > "$WORK/declared.txt"

printf '0002_a.sql\n0003_b.sql\n0004_c.sql\n' > "$WORK/all-present.txt"
OUT=$(missing_from "$WORK/declared.txt" "$WORK/all-present.txt"); CODE=$?
expect_code 0 "$CODE" "a store carrying everything declared is current"
[[ -z $OUT ]] && pass || fail "a current store must print nothing, got: $OUT"

printf '0002_a.sql\n' > "$WORK/one-present.txt"
OUT=$(missing_from "$WORK/declared.txt" "$WORK/one-present.txt"); CODE=$?
expect_code 1 "$CODE" "a store missing files is behind"
contains "$OUT" "0003_b.sql" "behind: names the first missing file"
contains "$OUT" "0004_c.sql" "behind: names the second missing file"
case "$OUT" in
  *0002_a.sql*) fail "behind: must not report a file the store already has" ;;
  *) pass ;;
esac

# A store with no ledger at all is behind by everything, not current. This is
# the exact state production ClickHouse was in from the 2026-08-27 cutover
# onward, and the state that must not read as a pass.
OUT=$(missing_from "$WORK/declared.txt" "$WORK/does-not-exist.txt"); CODE=$?
expect_code 1 "$CODE" "a store with no ledger is behind, not current"
contains "$OUT" "0002_a.sql" "no ledger: everything declared is reported missing"

# `comm` produces silent nonsense on unsorted input, and it is a store's schema
# that would be misreported. Both sides are sorted inside the function, so an
# input in any order gives the same verdict.
printf '0004_c.sql\n0002_a.sql\n0003_b.sql\n' > "$WORK/unsorted-declared.txt"
printf '0003_b.sql\n0004_c.sql\n0002_a.sql\n' > "$WORK/unsorted-present.txt"
OUT=$(missing_from "$WORK/unsorted-declared.txt" "$WORK/unsorted-present.txt"); CODE=$?
expect_code 0 "$CODE" "unsorted input on both sides still compares correctly"

# A store holding something the repository does not declare is a different
# question — someone applied an uncommitted migration — and this check is not
# it. Reporting it here would make every verdict ambiguous.
printf '0002_a.sql\n0003_b.sql\n0004_c.sql\n0099_hand_applied.sql\n' > "$WORK/ahead.txt"
OUT=$(missing_from "$WORK/declared.txt" "$WORK/ahead.txt"); CODE=$?
expect_code 0 "$CODE" "a store ahead of the repository is not what this reports"

# A missing declared list is a check that did not happen, which is neither
# verdict. 2, not 1, so a caller cannot read it as drift.
missing_from "$WORK/no-such-declared.txt" "$WORK/all-present.txt" >/dev/null 2>&1
expect_code 2 "$?" "an unreadable declared list is 'unknown', not 'behind'"

# --- neo4j_declared_names --------------------------------------------------

cat > "$WORK/schema.cypher" <<'CYPHER'
// A commented-out constraint is not declared. Counting it would make this
// check red forever against a correct store.
// CREATE CONSTRAINT ghost_constraint IF NOT EXISTS FOR (n:Ghost) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT tenant_public_id IF NOT EXISTS FOR (n:Tenant) REQUIRE n.publicId IS UNIQUE;
CREATE INDEX execution_org IF NOT EXISTS FOR (n:Execution) ON (n.orgId);
CREATE VECTOR INDEX memory_embedding IF NOT EXISTS FOR (n:AgentMemory) ON (n.embedding);
CREATE FULLTEXT INDEX document_text IF NOT EXISTS FOR (n:Document) ON EACH [n.body];
MATCH (n:KnowledgeNode) SET n:GraphNode;
CYPHER

NAMES=$(neo4j_declared_names "$WORK/schema.cypher")
contains "$NAMES" "tenant_public_id" "cypher: reads a named constraint"
contains "$NAMES" "execution_org" "cypher: reads a named index"
contains "$NAMES" "memory_embedding" "cypher: reads a named VECTOR index"
contains "$NAMES" "document_text" "cypher: reads a named FULLTEXT index"
case "$NAMES" in
  *ghost_constraint*) fail "cypher: a commented-out declaration must not count" ;;
  *) pass ;;
esac
# A relabel or a backfill leaves no name in SHOW CONSTRAINTS, so treating it as
# declared would report drift that can never clear.
case "$NAMES" in
  *MATCH*|*KnowledgeNode*) fail "cypher: a non-DDL statement must not be read as a declaration" ;;
  *) pass ;;
esac
if [[ $(printf '%s\n' "$NAMES" | grep -c .) -eq 4 ]]; then pass; else
  fail "cypher: expected exactly 4 names, got: $(printf '%s' "$NAMES" | tr '\n' ' ')"
fi

neo4j_declared_names "$WORK/nope.cypher" >/dev/null 2>&1
expect_code 2 "$?" "cypher: an unreadable schema file is 'unknown', not 'nothing declared'"

# --- neo4j_declared_vector_sizes -------------------------------------------
#
# A resize keeps the index name, so the name check read a schema.cypher that
# moved every vector index from 1,536 to 1,024 dimensions as current (#4148).

cat > "$WORK/vectors.cypher" <<'CYPHER'
// CREATE VECTOR INDEX ghost_vectors IF NOT EXISTS FOR (n:Ghost) ON (n.embedding)
// OPTIONS { indexConfig: { `vector.dimensions`: 64, `vector.similarity_function`: 'cosine' } };
CREATE VECTOR INDEX memory_embedding_index IF NOT EXISTS
FOR (n:AgentMemory) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1024, `vector.similarity_function`: 'cosine' } };
DROP INDEX engram_memory_embedding_index IF EXISTS;
CREATE INDEX execution_org IF NOT EXISTS FOR (n:Execution) ON (n.orgId);
CREATE VECTOR INDEX graph_node_embedding_index IF NOT EXISTS
FOR (n:GraphNode) ON (n.embedding)
OPTIONS { indexConfig: { `vector.dimensions`: 1024, `vector.similarity_function`: 'cosine' } };
CYPHER

SIZES=$(neo4j_declared_vector_sizes "$WORK/vectors.cypher")
contains "$SIZES" "memory_embedding_index 1024" "vector sizes: reads a multi-line vector index with its size"
contains "$SIZES" "graph_node_embedding_index 1024" "vector sizes: reads every vector index"
case "$SIZES" in
  *ghost_vectors*) fail "vector sizes: a commented-out index must not count" ;;
  *) pass ;;
esac
case "$SIZES" in
  *execution_org*|*engram*) fail "vector sizes: only CREATE VECTOR INDEX statements count" ;;
  *) pass ;;
esac
if [[ $(printf '%s\n' "$SIZES" | grep -c .) -eq 2 ]]; then pass; else
  fail "vector sizes: expected exactly 2 pairs, got: $(printf '%s' "$SIZES" | tr '\n' ' ')"
fi

# An index of the old size reads as missing, so the gate applies the schema.
printf 'graph_node_embedding_index 1024\nmemory_embedding_index 1536\n' > "$WORK/vec-present.txt"
printf '%s\n' "$SIZES" > "$WORK/vec-declared.txt"
MISSING=$(missing_from "$WORK/vec-declared.txt" "$WORK/vec-present.txt")
contains "$MISSING" "memory_embedding_index 1024" "vector sizes: an index of the old size reads as behind"
case "$MISSING" in
  *graph_node_embedding_index*) fail "vector sizes: an index of the current size must not read as behind" ;;
  *) pass ;;
esac

neo4j_declared_vector_sizes "$WORK/nope.cypher" >/dev/null 2>&1
expect_code 2 "$?" "vector sizes: an unreadable schema file is 'unknown', not 'nothing declared'"

# Each database is compared on its own, so a pooled database that is current
# cannot hide an organisation database at the old size.
printf 'memory_embedding_index 1024\n' > "$WORK/one-index.txt"
DECLARED=$( { prefix_lines neo4j "$WORK/one-index.txt"; prefix_lines org-acme "$WORK/one-index.txt"; } )
contains "$DECLARED" "neo4j memory_embedding_index 1024" "vector sizes: declares the pooled database's indexes"
contains "$DECLARED" "org-acme memory_embedding_index 1024" "vector sizes: declares each organisation database's indexes"
printf '%s\n' "$DECLARED" > "$WORK/db-declared.txt"
printf 'neo4j memory_embedding_index 1024\norg-acme memory_embedding_index 1536\n' > "$WORK/db-present.txt"
DB_MISSING=$(missing_from "$WORK/db-declared.txt" "$WORK/db-present.txt")
contains "$DB_MISSING" "org-acme memory_embedding_index 1024" "vector sizes: an organisation database at the old size reads as behind"
case "$DB_MISSING" in
  *"neo4j memory_embedding_index"*) fail "vector sizes: a current pooled database must not read as behind" ;;
  *) pass ;;
esac
: > "$WORK/empty.txt"
if [[ -z $(prefix_lines neo4j "$WORK/empty.txt") ]]; then pass; else
  fail "vector sizes: an empty result must prefix to nothing"
fi

# --- the real declarations this ships against ------------------------------
#
# The fixtures above prove the parsing; these prove it is pointed at something.
# An empty declared list would make the check pass against any store at all,
# which is the failure mode that would make this whole file worthless.

REAL_CYPHER="$REPO/packages/ontology/src/schema.cypher"
if [[ -f $REAL_CYPHER ]]; then
  REAL=$(neo4j_declared_names "$REAL_CYPHER")
  n=$(printf '%s\n' "$REAL" | grep -c .)
  if [[ $n -gt 20 ]]; then pass; else fail "the real schema.cypher parsed to only $n names"; fi
  contains "$REAL" "tenant_public_id" "the real schema.cypher yields a constraint known to be in it"
  REAL_SIZES=$(neo4j_declared_vector_sizes "$REAL_CYPHER")
  contains "$REAL_SIZES" "graph_node_embedding_index 1024" "the real schema.cypher yields the universal vector index at 1,024 dimensions"
else
  fail "packages/ontology/src/schema.cypher is gone — the Neo4j half of this check has no input"
fi

n=0
for f in "$REPO"/packages/telemetry/src/migrations/*.sql; do
  [[ -e $f ]] && n=$((n + 1))
done
if [[ $n -gt 0 ]]; then pass; else
  fail "no ClickHouse migrations found — the ClickHouse half of this check has no input"
fi

# --- report_drift ----------------------------------------------------------
#
# A verdict a reader cannot act on sends them back to run the same two queries
# by hand, which is how this went unnoticed for a fortnight in the first place.

GOOD=$(report_drift "ClickHouse" "$WORK/declared.txt" "$WORK/all-present.txt" 2>&1); CODE=$?
expect_code 0 "$CODE" "report: a current store exits 0"
contains "$GOOD" "current" "report: says the store is current"
case "$GOOD" in
  *::error::*) fail "report: a current store must not emit an error annotation" ;;
  *) pass ;;
esac

BAD=$(report_drift "ClickHouse" "$WORK/declared.txt" "$WORK/one-present.txt" 2>&1); CODE=$?
expect_code 1 "$CODE" "report: a store that is behind exits 1"
contains "$BAD" "::error::" "report: behind is annotated as an error, so it is visible in the run"
contains "$BAD" "ClickHouse" "report: names the store"
contains "$BAD" "0003_b.sql" "report: names what is missing"
contains "$BAD" "Store Migrate" "report: names the workflow that applies it"

# An existing but EMPTY ledger is the state production ClickHouse was actually
# in, and the counting has to survive it. `grep -c .` prints 0 and exits 1 on an
# empty file, so the obvious inline form emits "0" twice and the verdict reads
# "0\n0 present" — mangling the one line a reader pastes into an incident.
: > "$WORK/empty-ledger.txt"
expect_code 0 "$(count_names "$WORK/empty-ledger.txt")" "count: an empty file counts 0, once"
expect_code 0 "$(count_names "$WORK/no-such-file.txt")" "count: an absent file counts 0, once"
expect_code 3 "$(count_names "$WORK/declared.txt")" "count: three declared counts 3"

EMPTY=$(report_drift "ClickHouse" "$WORK/declared.txt" "$WORK/empty-ledger.txt" 2>&1); CODE=$?
expect_code 1 "$CODE" "report: an empty ledger is behind, not current"
contains "$EMPTY" "3 declared, 0 present" "report: an empty ledger counts once, on one line"

NEVER=$(report_drift "Neo4j" "$WORK/declared.txt" "$WORK/does-not-exist.txt" 2>&1); CODE=$?
expect_code 1 "$CODE" "report: a store that has never been migrated exits 1"
contains "$NEVER" "Neo4j" "report: names the store that has never been migrated"

# --- what a code review found, and what now holds it -----------------------
#
# Every case below is a defect that shipped past the first version of this file.
# They share a shape worth naming: the pure half was well tested, and the half
# that talks to a database was "tested" by grepping the script's own source —
# which cannot notice that a query is invalid, that an error was classified off
# the wrong stream, or that nothing was declared.

# An UNNAMED `CREATE CONSTRAINT IF NOT EXISTS` ends the matched prefix on the
# word IF. Left in, "IF" enters the declared set and reports drift no apply can
# ever clear, because Neo4j auto-names such a constraint.
cat > "$WORK/unnamed.cypher" <<'CYPHER'
CREATE CONSTRAINT IF NOT EXISTS FOR (n:X) REQUIRE n.id IS UNIQUE;
CREATE INDEX IF NOT EXISTS FOR (n:Y) ON (n.z);
CREATE CONSTRAINT real_name IF NOT EXISTS FOR (n:Z) REQUIRE n.id IS UNIQUE;
CYPHER
UNNAMED=$(neo4j_declared_names "$WORK/unnamed.cypher")
contains "$UNNAMED" "real_name" "cypher: a named declaration beside unnamed ones is still read"
case "$UNNAMED" in
  *IF*) fail "cypher: an unnamed declaration must not enter the set as 'IF'" ;;
  *) pass ;;
esac
if [[ $(printf '%s\n' "$UNNAMED" | grep -c .) -eq 1 ]]; then pass; else
  fail "cypher: expected only the named one, got: $(printf '%s' "$UNNAMED" | tr '\n' ' ')"
fi

# schema.sql is applied on every call OUTSIDE the ledger, so a store with a
# complete `_migrations` table and none of these tables would have answered
# "current" — the false green that would make this whole check decorative.
cat > "$WORK/schema.sql" <<'SQL'
-- CREATE TABLE commented_out (x Int8) ENGINE = Log;
CREATE TABLE IF NOT EXISTS execution_logs (x Int8) ENGINE = Log;
CREATE TABLE events (x Int8) ENGINE = Log;
CREATE TABLE IF NOT EXISTS oxagen.token_usage (x Int8) ENGINE = Log;
ALTER TABLE events ADD COLUMN y Int8;
SQL
TBL=$(clickhouse_declared_tables "$WORK/schema.sql")
contains "$TBL" "execution_logs" "schema.sql: reads IF NOT EXISTS form"
contains "$TBL" "events" "schema.sql: reads the bare CREATE TABLE form"
contains "$TBL" "token_usage" "schema.sql: strips the database qualifier"
case "$TBL" in
  *commented_out*) fail "schema.sql: a commented-out table must not count" ;;
  *) pass ;;
esac
case "$TBL" in
  *ALTER*) fail "schema.sql: ALTER must not be read as a declaration" ;;
  *) pass ;;
esac
clickhouse_declared_tables "$WORK/no-such.sql" >/dev/null 2>&1
expect_code 2 "$?" "schema.sql: an unreadable file is 'unknown', not 'nothing declared'"

REAL_SQL="$REPO/packages/telemetry/src/schema.sql"
if [[ -f $REAL_SQL ]]; then
  n=$(clickhouse_declared_tables "$REAL_SQL" | grep -c .)
  if [[ $n -gt 5 ]]; then pass; else fail "the real schema.sql parsed to only $n tables"; fi
else
  fail "packages/telemetry/src/schema.sql is gone — half the ClickHouse check has no input"
fi

# --- clickhouse_migration_tables -------------------------------------------
#
# A ledger row is a filename, not a table. migrate.ts's pre-ledger baseline
# bootstrap records files as applied WITHOUT executing them, so the ledger
# half of this check can read complete against a store that is missing the
# tables those files create. That is #3698: production held zero error_events
# rows for weeks and this script reported ClickHouse current the whole time.

MIGS="$WORK/migrations"
mkdir -p "$MIGS"
cat > "$MIGS/0001_create.sql" <<'SQL'
CREATE TABLE IF NOT EXISTS kept_events (x Int8) ENGINE = Log;
CREATE TABLE oxagen.qualified_events (x Int8) ENGINE = Log;
CREATE TABLE IF NOT EXISTS dropped_later (x Int8) ENGINE = Log;
-- CREATE TABLE commented_out (x Int8) ENGINE = Log;
SQL
cat > "$MIGS/0002_alter.sql" <<'SQL'
ALTER TABLE kept_events ADD COLUMN y Int8;
SQL
cat > "$MIGS/0003_drop.sql" <<'SQL'
DROP TABLE IF EXISTS dropped_later;
SQL
# The shape 0021 has: a DROP and a CREATE of the SAME table, in one file, in
# that order. Read per-file rather than per-statement the drop wins, and the
# check would demand a table the migration deliberately restores — red forever.
cat > "$MIGS/0004_recreate.sql" <<'SQL'
DROP TABLE IF EXISTS kept_events;
CREATE TABLE IF NOT EXISTS kept_events (x Int8, y Int8) ENGINE = Log;
SQL

MIGT=$(clickhouse_migration_tables "$MIGS")
contains "$MIGT" "kept_events" "migrations: a table dropped and re-created in one file survives"
contains "$MIGT" "qualified_events" "migrations: the database qualifier is stripped"
case "$MIGT" in
  *dropped_later*) fail "migrations: a table dropped by a later file must not be demanded" ;;
  *) pass ;;
esac
case "$MIGT" in
  *commented_out*) fail "migrations: a commented-out table must not count" ;;
  *) pass ;;
esac
case "$MIGT" in
  *IF*|*EXISTS*|*NOT*) fail "migrations: a keyword must not enter the set as a table name" ;;
  *) pass ;;
esac
case "$MIGT" in
  *ALTER*) fail "migrations: ALTER must not be read as a declaration" ;;
  *) pass ;;
esac

clickhouse_migration_tables "$WORK/no-such-dir" >/dev/null 2>&1
expect_code 2 "$?" "migrations: an unreadable directory is 'unknown', not 'nothing declared'"

# --- clickhouse_all_declared_tables ----------------------------------------
#
# The union is what the live check compares against system.tables, so it is
# what has to be tested. Asserting instead that the script MENTIONS
# clickhouse_migration_tables proves only that the name appears: a version that
# called it and threw the output away passed that assertion and shipped the
# same false green.

BOTH=$(clickhouse_all_declared_tables "$WORK/schema.sql" "$MIGS"); CODE=$?
expect_code 0 "$CODE" "union: both sources readable is a clean read"
contains "$BOTH" "execution_logs" "union: carries what schema.sql declares"
contains "$BOTH" "kept_events" "union: carries what the migrations declare"
case "$BOTH" in
  *dropped_later*) fail "union: a table the migrations dropped must not be demanded" ;;
  *) pass ;;
esac
# schema.sql and the migrations both declare some tables. A duplicate in the
# declared list is harmless to `comm`, but it doubles the count in the verdict
# line someone pastes into an incident.
cat > "$WORK/overlap.sql" <<'SQL'
CREATE TABLE IF NOT EXISTS kept_events (x Int8) ENGINE = Log;
SQL
OVER=$(clickhouse_all_declared_tables "$WORK/overlap.sql" "$MIGS")
if [[ $(printf '%s\n' "$OVER" | grep -cx kept_events) -eq 1 ]]; then pass; else
  fail "union: a table both sources declare must appear once, not twice"
fi

# Half an answer compared against system.tables is a report of drift that is
# not there — the one direction a drift check must never be wrong in.
clickhouse_all_declared_tables "$WORK/no-such.sql" "$MIGS" >/dev/null 2>&1
expect_code 2 "$?" "union: an unreadable schema.sql is 'unknown', not a shorter list"
clickhouse_all_declared_tables "$WORK/schema.sql" "$WORK/no-such-dir" >/dev/null 2>&1
expect_code 2 "$?" "union: an unreadable migrations dir is 'unknown', not a shorter list"

# The assertion #3698 turns on. error_events is created by a migration and by
# nothing in schema.sql, so before this function it was covered only by the
# ledger — the one source that can be complete while the table is absent.
REAL_MIGS="$REPO/packages/telemetry/src/migrations"
if [[ -d $REAL_MIGS ]]; then
  REAL_MIGT=$(clickhouse_migration_tables "$REAL_MIGS")
  contains "$REAL_MIGT" "error_events" "the real migrations declare error_events as a table to verify (#3698)"
  contains "$REAL_MIGT" "tacho_events" "the real migrations declare tacho_events as a table to verify"
  # Created by a migration and dropped by a later one — 0006 then 0007 for
  # agent_executions, 0005 then 0010 for session_recaps. Demanding either would
  # be permanent false drift that no apply could clear. The other three names
  # 0010 drops were never created by a migration at all, so they cover the
  # drop-of-something-this-never-declared case instead.
  for dead in agent_executions session_recaps traces spans api_key_events agent_logs; do
    case "$REAL_MIGT" in
      *"$dead"*) fail "the real migrations: $dead was dropped and must not be demanded" ;;
      *) pass ;;
    esac
  done
  n=$(printf '%s\n' "$REAL_MIGT" | grep -c .)
  if [[ $n -gt 10 ]]; then pass; else fail "the real migrations parsed to only $n tables"; fi
else
  fail "packages/telemetry/src/migrations is gone — half the ClickHouse check has no input"
fi

# Unknown must outrank behind. ClickHouse unreadable then Neo4j behind used to
# exit 1 and report "a store is behind", saying nothing about the store nobody
# could read — and the two need different responses.
status=0; bump_status 1; expect_code 1 "$status" "status: clean then behind is behind"
status=0; bump_status 2; bump_status 1; expect_code 2 "$status" "status: unknown is not overwritten by behind"
status=0; bump_status 1; bump_status 2; expect_code 2 "$status" "status: behind is raised to unknown"
status=0; bump_status 0; expect_code 0 "$status" "status: clean stays clean"
status=1; bump_status 0; expect_code 1 "$status" "status: a later clean store does not clear an earlier one"

# An empty DECLARED list is a check that did not happen. Without this a renamed
# directory would compare every store current, exit 0, and CLOSE the open drift
# issue — claiming a recovery off no answer at all.
status=0
: > "$WORK/nothing.txt"
require_declarations "ClickHouse" "$WORK/nothing.txt" >/dev/null 2>&1
expect_code 1 "$?" "declared: an empty list is refused"
expect_code 2 "$status" "declared: an empty list makes the run 'unknown', not 'behind'"
EMPTY_MSG=$(require_declarations "ClickHouse" "$WORK/nothing.txt" 2>&1)
contains "$EMPTY_MSG" "broken check, not a clean store" "declared: says which of the two it is"
status=0
require_declarations "ClickHouse" "$WORK/declared.txt" >/dev/null 2>&1
expect_code 0 "$?" "declared: a populated list is accepted"
expect_code 0 "$status" "declared: a populated list does not disturb the status"

# curl --fail-with-body writes the SERVER's error body to STDOUT and only its
# own generic line to stderr. Classifying the remote error by grepping stderr
# never matched, so "this store has never been migrated" — the one state this
# check was built for — reported as "could not be read" and sent the responder
# to the SSM runbook.
printf 'curl: (22) The requested URL returned error: 404\n' > "$WORK/err.txt"
printf 'Code: 60. DB::Exception: Table oxagen._migrations does not exist. (UNKNOWN_TABLE)\n' > "$WORK/body.txt"
ch_missing_object "$WORK/err.txt" "$WORK/body.txt"
expect_code 0 "$?" "clickhouse: a missing table is recognised from the body on stdout"
printf 'curl: (7) Failed to connect to 127.0.0.1 port 8123\n' > "$WORK/err2.txt"
: > "$WORK/body2.txt"
ch_missing_object "$WORK/err2.txt" "$WORK/body2.txt"
expect_code 1 "$?" "clickhouse: a refused connection is not a missing table"

# Read-only is enforced on the server rather than asserted about the source.
expect_code 0 "$([[ $(ch_url_readonly "http://h:8123/") == "http://h:8123/?readonly=1" ]] && echo 0 || echo 1)" \
  "readonly: appended with ? when there is no query string"
expect_code 0 "$([[ $(ch_url_readonly "http://h:8123/?database=x") == "http://h:8123/?database=x&readonly=1" ]] && echo 0 || echo 1)" \
  "readonly: appended with & when there is one"

# curl's config file has one credential option, `user`, whose value is
# "user:password". A `password` line is not an option curl has: Ubuntu's curl
# warned, prompted for the password on a non-tty, read nothing and sent the
# user alone — AUTHENTICATION_FAILED, three scheduled runs red, and an issue
# (#2987) that read as a rotated credential. macOS's curl refuses the file.
# Both halves are held here: the rendered text, and what real curl does with it.
CFG=$(ch_curl_config oxagen s3cret)
[[ $CFG == 'user = "oxagen:s3cret"' ]] && pass || fail "curl config: expected user = \"oxagen:s3cret\", got: $CFG"
case "$CFG" in
  *password*) fail "curl config: curl has no 'password' option — the credential goes in 'user' as user:password" ;;
  *) pass ;;
esac
CFG=$(ch_curl_config 'ox"a\gen' 'p"w\d')
[[ $CFG == 'user = "ox\"a\\gen:p\"w\\d"' ]] && pass || fail "curl config: a quote or backslash in the credential must be escaped, got: $CFG"
# Real curl, no server: the only acceptable outcome is a connection failure.
# A config curl cannot read fails before connecting ("error encountered when
# reading a file"), and a user with no password makes it prompt ("Enter host
# password"); neither may appear.
CURL_OUT=$(ch_curl_config oxagen s3cret | curl -sS --max-time 2 --config - http://127.0.0.1:9/ </dev/null 2>&1 || true)
case "$CURL_OUT" in
  *"Enter host password"*|*"error encountered when reading"*|*"Unknown option"*|*"Warning"*)
    fail "curl config: real curl did not accept the rendered config: $CURL_OUT" ;;
  *) pass ;;
esac
# The port is closed, so the credential was accepted and curl got as far as
# the connection — anything short of that would have failed above.
contains "$CURL_OUT" "Failed to connect" "curl config: real curl reached the connect stage with the credential in place"

# A cypher-shell result opens with its `name` header. Without it the file is
# not a result: on 2026-09-15 cypher-shell printed "Unsupported Java 17
# detected" and exited 0 with no rows, the header-dropping tail read that as an
# empty result, and the check reported "55 declared, 0 present" against a
# database carrying all 55 (#3036). An empty database and a refused query must
# not collapse into one another — the header is what tells them apart.
#
# cypher-shell prints that header only above a first row. A query that matches
# nothing prints nothing, exactly like a query that never ran, so the script
# writes every query to return at least one row (see the shipped-script checks
# below). On 2026-09-26 the organisation database listing filtered in Cypher,
# matched nothing on production, and blocked the migration gate on 3069a18.
printf 'name\n"tenant_public_id"\n"execution_org"\n\n' > "$WORK/neo-ok.txt"
OUT=$(neo_result_names "$WORK/neo-ok.txt"); CODE=$?
expect_code 0 "$CODE" "neo4j result: a headed result is read"
[[ $OUT == $'tenant_public_id\nexecution_org' ]] && pass || fail "neo4j result: expected two unquoted names, got: $OUT"
# The vector size query answers a blank for every index that is not a vector
# index, so a database with only lookup indexes still returns rows.
printf 'name\n""\n"memory_embedding_index 1024"\n""\n' > "$WORK/neo-blanks.txt"
OUT=$(neo_result_names "$WORK/neo-blanks.txt"); CODE=$?
expect_code 0 "$CODE" "neo4j result: a result with blank rows is read"
[[ $OUT == "memory_embedding_index 1024" ]] && pass || fail "neo4j result: blank rows must be dropped, got: $OUT"
printf 'name\n""\n""\n' > "$WORK/neo-all-blank.txt"
OUT=$(neo_result_names "$WORK/neo-all-blank.txt"); CODE=$?
expect_code 0 "$CODE" "neo4j result: a database with no vector index is a real, empty answer"
[[ -z $OUT ]] && pass || fail "neo4j result: only blank rows must print nothing, got: $OUT"
printf 'Unsupported Java 17.0.20.1 detected. Please use Java(TM) 21 or Java(TM) 25 to run Cypher Shell.\n' > "$WORK/neo-java.txt"
neo_result_names "$WORK/neo-java.txt" >/dev/null 2>&1
expect_code 2 "$?" "neo4j result: cypher-shell refusing to run is 'unknown', not 'nothing present'"
: > "$WORK/neo-none.txt"
neo_result_names "$WORK/neo-none.txt" >/dev/null 2>&1
expect_code 2 "$?" "neo4j result: no output at all is 'unknown', not 'nothing present'"
neo_result_names "$WORK/does-not-exist.txt" >/dev/null 2>&1
expect_code 2 "$?" "neo4j result: a missing file is 'unknown'"

# --- the shipped script ----------------------------------------------------

SCRIPT=$(cat "$TOOLS/check-store-drift.sh")

# Read-only is the contract. Applying is a manual dispatch with a person reading
# the pending list, and a scheduled job that could apply would quietly become
# the thing that migrates production at 3am.
# Named by how the applier is actually run rather than by its filename, so the
# script may still explain itself in a comment. `db-migrate.ts` is reached as
# `npx tsx tools/scripts/db-migrate.ts`; neither runner appears here.
case "$SCRIPT" in
  *"npx "*|*"tsx "*) fail "script: must not invoke the applier — this check is read-only" ;;
  *) pass ;;
esac
# What it SENDS is read, checked structurally rather than by scanning the whole
# file for forbidden words — the file legitimately mentions CREATE TABLE, since
# it parses schema.sql for exactly those. Every ch_query call site must open
# with SELECT, and every neo_cypher call site with SHOW.
bad=$(grep -oE 'ch_query "[^"]*' "$TOOLS/check-store-drift.sh" | grep -cv 'ch_query "SELECT' || true)
expect_code 0 "$bad" "script: every ClickHouse statement it sends is a SELECT"
sent=$(grep -cE 'ch_query "SELECT' "$TOOLS/check-store-drift.sh" || true)
if [[ $sent -ge 2 ]]; then pass; else fail "script: expected both ClickHouse reads, found $sent"; fi

bad=$(grep -oE 'neo_cypher "[^"]*' "$TOOLS/check-store-drift.sh" | grep -cv 'neo_cypher "SHOW' || true)
expect_code 0 "$bad" "script: every Neo4j statement it sends is a SHOW"
bad=$(grep -oE 'neo_cypher_on [^ ]+ "[^"]*' "$TOOLS/check-store-drift.sh" | grep -cv ' "SHOW' || true)
expect_code 0 "$bad" "script: every Neo4j statement it sends to a named database is a SHOW"
sent=$(grep -cE 'neo_cypher_on [^ ]+ "SHOW' "$TOOLS/check-store-drift.sh" || true)
if [[ $sent -ge 2 ]]; then pass; else fail "script: expected the database listing and the vector read, found $sent"; fi

# A query that matches no row prints nothing, which reads as unknown. The two
# vector size queries filter outside Cypher so each always has a row: SHOW
# DATABASES lists at least `system`, and every database has its lookup indexes.
contains "$SCRIPT" "SHOW DATABASES YIELD name RETURN DISTINCT name" "script: lists every database and filters the organisation ones itself"
contains "$SCRIPT" "RETURN CASE WHEN type = 'VECTOR' THEN" "script: reads every index and blanks the ones that are not vector indexes"
case "$SCRIPT" in
  *"SHOW DATABASES YIELD name WHERE"*) fail "script: a WHERE on SHOW DATABASES can match nothing, and nothing reads as unknown" ;;
  *) pass ;;
esac
case "$SCRIPT" in
  *"WHERE type = 'VECTOR'"*) fail "script: a WHERE on the vector index read can match nothing, and nothing reads as unknown" ;;
  *) pass ;;
esac
contains "$SCRIPT" "_migrations" "script: reads the ledger db-migrate.ts actually writes"
contains "$SCRIPT" "system.tables" "script: also asks which tables exist, not only the ledger"
contains "$SCRIPT" "readonly=1" "script: read-only is enforced on the server, not asserted about the text"

# SHOW cannot be a UNION branch — Neo4j 5.24 answers that with a syntax error,
# so a single combined statement made the Neo4j half permanently unrunnable and
# the job permanently red on "could not be read". Two statements now.
contains "$SCRIPT" "SHOW CONSTRAINTS YIELD name RETURN name" "script: asks Neo4j for its constraint names"
contains "$SCRIPT" "SHOW INDEXES YIELD name RETURN name" "script: asks Neo4j for its index names separately"
case "$SCRIPT" in
  *"UNION ALL SHOW"*) fail "script: SHOW cannot be a UNION branch in Cypher" ;;
  *) pass ;;
esac

# A SHOW answers for one database. The applier writes to NEO4J_DATABASE — the
# ontology client's session() selects it, and store-migrate.yml reads it before
# applying schema.cypher — so a check that omits -d asks the connection default
# instead and reports "0 present" about a database nothing migrates.
contains "$SCRIPT" '-d "${NEO4J_DATABASE:-neo4j}"' \
  "script: reads the database the applier writes to, not the connection default"
# The header documents the environment this script is handed, and a hand-run
# caller reads it rather than the code. A variable the script reads but the
# header omits is answered with the fallback, silently and plausibly — which is
# the same false-answer shape the -d above exists to close.
#
# Read from the indented all-caps block alone, not from the whole header: prose
# elsewhere naming a variable in passing would otherwise satisfy this, and the
# first version of this assertion did exactly that — it passed with
# NEO4J_DATABASE deleted from the list, because the paragraph under the list
# mentions it.
ENV_LIST=$(grep -E '^#   [A-Z0-9_]+( [A-Z0-9_]+)*$' "$TOOLS/check-store-drift.sh")
for var in CLICKHOUSE_URL CLICKHOUSE_USERNAME CLICKHOUSE_PASSWORD CLICKHOUSE_DATABASE \
           NEO4J_URI NEO4J_USERNAME NEO4J_PASSWORD NEO4J_DATABASE; do
  case " $ENV_LIST " in
    *" $var "*|*" $var"$'\n'*) pass ;;
    *) fail "script: the header's environment list omits $var, which the script reads" ;;
  esac
done
# Something has to supply it, or the fallback above silently becomes the answer
# on every run.
#
# That read used to live in store-migrate-drift.yml and now lives in the
# composite action both callers share, so the assertion follows it there. Every
# caller is checked too: an action that reads the parameter is worth nothing to
# a workflow that stopped calling it, and this test's whole subject is a value
# whose absence is invisible because the fallback is plausible.
TUNNEL_ACTION="$REPO/.github/actions/open-store-tunnels/action.yml"
if [[ -f $TUNNEL_ACTION ]]; then
  contains "$(cat "$TUNNEL_ACTION")" "NEO4J_DATABASE" \
    "action: reads NEO4J_DATABASE from Parameter Store like store-migrate.yml"
else
  fail "action: .github/actions/open-store-tunnels/action.yml is gone"
fi

# store-migrate-drift.yml asks every morning; pipeline.yml's migration-gate asks
# before a deploy ships code that assumes the answer. Both reach the stores the
# same way, and neither can reach them without this.
for caller in \
  "$REPO/.github/workflows/store-migrate-drift.yml" \
  "$REPO/.github/workflows/pipeline.yml"
do
  if [[ -f $caller ]]; then
    contains "$(cat "$caller")" "./.github/actions/open-store-tunnels" \
      "caller: $(basename "$caller") opens the tunnels through the shared action"
  else
    fail "caller: $caller is gone"
  fi
done

# Credentials belong out of the process table on a shared runner.
case "$SCRIPT" in
  *'-u "$NEO4J_USERNAME"'*|*'--user "$CLICKHOUSE_USERNAME'*)
    fail "script: a store password must not be passed in argv" ;;
  *) pass ;;
esac
# A store that was not checked must not read as a store that passed.
contains "$SCRIPT" "cypher-shell is not installed" "script: a skipped Neo4j check is an error"

# --- result ---------------------------------------------------------------

if [[ $FAILED -gt 0 ]]; then
  echo "check-store-drift: $FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "check-store-drift: $CASES assertions passed"
