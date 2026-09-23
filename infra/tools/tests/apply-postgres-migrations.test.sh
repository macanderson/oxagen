#!/usr/bin/env bash
#
# Holds apply-postgres-migrations.sh to its one safety property: it applies only
# when a readable store is a few migrations behind, and never when the store is
# unreadable or its revision table is empty. A stub stands in for
# run-db-migrations.sh and records every call it gets.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOLS=$(cd "$HERE/.." && pwd)

FAILED=0
CASES=0

pass() { CASES=$((CASES + 1)); }
fail() {
  CASES=$((CASES + 1))
  FAILED=$((FAILED + 1))
  echo "FAIL: $1" >&2
}

expect_eq() {
  local want=$1 got=$2 label=$3
  if [[ $want == "$got" ]]; then pass; else fail "$label — wanted '$want', got '$got'"; fi
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/postgres-apply-test-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# Three declared migrations.
mkdir -p "$WORK/db/atlas/migrations"
for f in 20260101000000_a.sql 20260102000000_b.sql 20260103000000_c.sql; do
  : > "$WORK/db/atlas/migrations/$f"
done

status_ok='Migration Status: OK
  -- Current Version: 20260103000000
  -- Next Version:    Already at latest version
  -- Executed Files:  3
  -- Pending Files:   0'

status_one_pending='Migration Status: PENDING
  -- Current Version: 20260102000000
  -- Next Version:    20260103000000
  -- Executed Files:  2
  -- Pending Files:   1'

status_all_pending='Migration Status: PENDING
  -- Current Version: No migration applied yet
  -- Next Version:    20260101000000
  -- Executed Files:  0
  -- Pending Files:   3'

# The stub prints the Nth scripted status on its Nth status call, logs "status"
# or "apply" per call, and fails an apply when APPLY_FAILS=1.
cat > "$WORK/stub.sh" <<'EOF'
#!/usr/bin/env bash
if [[ ${2:-} == "--apply" ]]; then
  echo apply >> "$STUB_LOG"
  [[ ${APPLY_FAILS:-0} == 1 ]] && exit 1
  exit 0
fi
echo status >> "$STUB_LOG"
n=$(grep -c status "$STUB_LOG")
f="$STUB_DIR/status-$n.txt"
[[ -f $f ]] || exit 1
cat "$f"
EOF

# run CASE_NAME STATUS... — scripts the stub's status answers, runs the script,
# and sets CODE and CALLS (the stub's call log joined by spaces).
run() {
  local name=$1
  shift
  local dir="$WORK/$name" i=1
  mkdir -p "$dir"
  : > "$dir/log"
  for s in "$@"; do
    printf '%s\n' "$s" > "$dir/status-$i.txt"
    i=$((i + 1))
  done
  STUB_LOG="$dir/log" STUB_DIR="$dir" DB_DIR="$WORK/db" RUN_DB_MIGRATIONS="$WORK/stub.sh" \
    bash "$TOOLS/apply-postgres-migrations.sh" > "$dir/out" 2>&1
  CODE=$?
  CALLS=$(tr '\n' ' ' < "$dir/log" | sed 's/ $//')
}

run current "$status_ok"
expect_eq 0 "$CODE" "a current store passes"
expect_eq "status" "$CALLS" "a current store is not applied to"

run behind "$status_one_pending" "$status_ok"
expect_eq 0 "$CODE" "a store one behind is applied to and then passes"
expect_eq "status apply status" "$CALLS" "the apply is followed by a fresh status"

run unstamped "$status_all_pending"
expect_eq 1 "$CODE" "an empty revision table blocks the deploy"
expect_eq "status" "$CALLS" "an empty revision table is never applied to"

run unreadable "no status line here"
expect_eq 2 "$CODE" "an unreadable store is unknown"
expect_eq "status" "$CALLS" "an unreadable store is never applied to"

run status-fails
expect_eq 2 "$CODE" "a failed status command is unknown"
expect_eq "status" "$CALLS" "a failed status command is never followed by an apply"

APPLY_FAILS=1 run apply-fails "$status_one_pending"
expect_eq 1 "$CODE" "a failed apply blocks the deploy"
expect_eq "status apply" "$CALLS" "a failed apply is not re-checked as if it worked"

run still-behind "$status_one_pending" "$status_one_pending"
expect_eq 1 "$CODE" "an apply that did not land blocks the deploy"

if [[ $FAILED -gt 0 ]]; then
  echo "$FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "apply-postgres-migrations: $CASES assertions passed"
