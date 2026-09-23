#!/usr/bin/env bash
#
# Bring production Postgres to the head of the migration directory, then prove
# it got there.
#
#   infra/tools/apply-postgres-migrations.sh
#
# Exits 0 when Aurora is current, whether it already was or this run applied
# what was pending. Exits 1 when it is behind and this script refused to apply
# or the apply did not land. Exits 2 when the store could not be read. Those are
# the same three codes `check-postgres-drift.sh` returns, so `migration-gate` in
# pipeline.yml decides on this script's answer the way it decided on that one.
#
# WHY IT EXISTS
#
# Mac decided on 2026-09-23 that CI applies production migrations on its own,
# which closes the question #3653 held open. Until then `migration-gate` only
# checked: a merged migration blocked every deploy until someone ran
# `run-db-migrations.sh --apply` by hand. Nobody is asked at the moment that
# matters, so main sat undeployed behind #3735's migration while every open
# branch piled up behind it. The four incidents that made the gate (#1275,
# #2796, #3449, #3692) were code reaching production ahead of its schema. This
# keeps that ordering and removes the human step: the gate applies, re-checks,
# and only then lets `deploy-node` ship.
#
# WHEN IT REFUSES TO APPLY
#
#   unknown        No verdict line, a failed SSM command, or counts that
#                  disagree. Nothing is applied against a store nobody could
#                  read (#3036).
#   all pending    Atlas lists every declared migration as pending, which means
#                  its revision table is empty, not that the store is new.
#                  Applying from there re-creates objects that already exist.
#                  That needs a person, so it still blocks the deploy.
#   out of order   Not passed `--exec-order non-linear`. A migration stamped
#                  before one production already carries makes Atlas refuse the
#                  apply, and that refusal is the right outcome: the branch
#                  renumbers its file (`db:lint-migrations` catches most of
#                  these before merge).
#
# OVERLAPPING RUNS
#
# Main runs one pipeline per commit, so two gates can apply at once.
# `run-db-migrations.sh` uploads a separate tarball for each call
# (`migration_object_key`), and `atlas migrate apply` holds a Postgres advisory
# lock for the whole apply. The second gate waits for the first, then finds
# nothing pending.
#
# RUN_DB_MIGRATIONS names the script that reaches production. Tests point it at
# a stub. Nothing else should set it.

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/tools/check-postgres-drift.sh
source "$HERE/check-postgres-drift.sh"

set -uo pipefail

REPO=$(cd "$HERE/../.." && pwd)
DB_DIR=${DB_DIR:-$REPO/packages/database}
MIGRATIONS="$DB_DIR/atlas/migrations"
RUN_DB_MIGRATIONS=${RUN_DB_MIGRATIONS:-$HERE/run-db-migrations.sh}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/postgres-apply-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# status OUT_FILE
#
# Asks production for `atlas migrate status` and classifies the answer. Returns
# the classifier's 0, 1 or 2. A failed status command is 2.
status() {
  local out=$1
  if ! bash "$RUN_DB_MIGRATIONS" "$DB_DIR" > "$out" 2>&1; then
    echo "::error::Postgres: the status command failed, so the store's state is unknown."
    sed '/^$/d' "$out" | sed 's/^/::error::  /' | tail -10
    return 2
  fi
  cat "$out"
  echo
  classify_atlas_status "$out" "$DECLARED"
}

echo "== Postgres migrations =="

DECLARED=$(find "$MIGRATIONS" -maxdepth 1 -name '*.sql' -type f 2>/dev/null | wc -l | tr -d ' ')
if [[ ${DECLARED:-0} -eq 0 ]]; then
  echo "::error::Postgres: no migrations found in $MIGRATIONS, so there is nothing to compare."
  exit 2
fi
echo "declared: $DECLARED migration files"

status "$WORK/before.txt"
code=$?
[[ $code -eq 0 || $code -eq 2 ]] && exit "$code"

# Behind. The classifier returns 1 both for "some pending" and for "the revision
# table is empty", and only the first may be applied.
pending=$(atlas_status_field "$WORK/before.txt" "Pending Files")
if [[ -z $pending || ! $pending =~ ^[0-9]+$ || $pending -ge $DECLARED ]]; then
  echo "::error::Postgres: not applying automatically. Pending count '${pending:-?}' of $DECLARED needs a person to read it first."
  exit 1
fi

echo "== applying $pending pending migration(s) =="
if ! bash "$RUN_DB_MIGRATIONS" "$DB_DIR" --apply 2>&1 | tee "$WORK/apply.txt"; then
  echo "::error::Postgres: the apply failed. Read the output above. Out-of-order timestamps mean the branch must renumber its migration."
  exit 1
fi

# The apply's own exit code is not the verdict. Only a fresh status call that
# reads current lets the deploy through.
echo "== re-checking after the apply =="
status "$WORK/after.txt"
code=$?
if [[ $code -ne 0 ]]; then
  echo "::error::Postgres: the apply reported success, but the store is still not current."
fi
exit "$code"
