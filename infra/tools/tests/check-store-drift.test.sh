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
else
  fail "packages/ontology/src/schema.cypher is gone — the Neo4j half of this check has no input"
fi

n=$(ls "$REPO"/packages/telemetry/src/migrations/*.sql 2>/dev/null | grep -c . || true)
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

NEVER=$(report_drift "Neo4j" "$WORK/declared.txt" "$WORK/does-not-exist.txt" 2>&1); CODE=$?
expect_code 1 "$CODE" "report: a store that has never been migrated exits 1"
contains "$NEVER" "Neo4j" "report: names the store that has never been migrated"

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
# The two statements it does send are reads. An INSERT or a CREATE here would
# make a scheduled job into the thing that migrates production at 3am.
case "$SCRIPT" in
  *"INSERT INTO"*|*"CREATE TABLE"*) fail "script: must send no write statement" ;;
  *) pass ;;
esac
contains "$SCRIPT" "_migrations" "script: reads the ledger db-migrate.ts actually writes"
contains "$SCRIPT" "SHOW CONSTRAINTS" "script: asks Neo4j for its constraint names"
# A store that was not checked must not read as a store that passed.
contains "$SCRIPT" "cypher-shell is not installed" "script: a skipped Neo4j check is an error"

# --- result ---------------------------------------------------------------

if [[ $FAILED -gt 0 ]]; then
  echo "check-store-drift: $FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "check-store-drift: $CASES assertions passed"
