#!/usr/bin/env bash
#
# Does production Postgres carry the Atlas migrations this repository declares?
#
#   infra/tools/check-postgres-drift.sh
#
# Exits 0 when Aurora is at the head of `packages/database/atlas/migrations`,
# 1 when it is behind, 2 when the check could not be made. Reads only — it
# never applies anything. Applying stays manual: `run-db-migrations.sh --apply`
# from a laptop, or the `DB Migrate (manual)` dispatch that runs the same
# script, with a human reading the pending list first (CLAUDE.md: "Deployment
# applies none of them.").
#
# WHY THIS EXISTS (#1275)
#
# `check-store-drift.sh` beside this file asks that question of ClickHouse and
# Neo4j. Its header explains why it skipped Postgres:
#
#   "Postgres has `atlas migrate status` and a revision table to answer that;
#    these two had neither a caller nor an equivalent."
#
# Postgres has the ANSWER. What it has never had is the CALLER. Nothing in this
# repository runs `atlas migrate status` against production on any trigger —
# not on a schedule, not on a merge, not before a deploy. So the store with the
# best instrumentation of the three is the only one whose drift is invisible,
# and it is the one that has taken production down: #1275 (2026-09-09,
# "column ... does not exist" 500s) and the login outage `pipeline.yml` names
# where `deploy-node` lost its `needs: [migrate]`.
#
# HOW IT ASKS
#
# Aurora's security group admits 5432 from the app node's security group and
# nothing else, so a hosted runner cannot connect (oxagen#2652). The one path
# that reaches it is `run-db-migrations.sh`, which resolves the cluster
# endpoint locally and sends `atlas migrate status --env ci` to the node over
# SSM; `db-migrate.yml`'s production job runs that script too. Called with no
# `--apply` that script is a dry run by construction: it prints the pending
# list and changes nothing.
#
# This script therefore adds no new access path and no new credential. It calls
# that script in its existing read-only mode and classifies what comes back.
#
# WHAT "BEHIND" MEANS, AND THE ONE CASE IT MUST NOT CONFUSE
#
# An empty revision table reports the ENTIRE history as pending. That is not a
# store one migration behind; it is a store Atlas has never stamped, and
# applying from there tries to re-create objects that already exist. Both
# `run-db-migrations.sh` and `db-migrate.yml` warn about it in prose to a human
# reading output. A machine gate has to draw the same line, because the
# response differs: one is "apply the pending migration", the other is "stop,
# the revision table is wrong". `classify_atlas_status` reports it as behind —
# a deploy must not proceed either way — and says which of the two it is.
#
# Nothing here prints a credential. `run-db-migrations.sh` reads the password on
# the node inside a tracing-off window and it never reaches this machine.

# atlas_status_line FILE
#
# The `Migration Status: X` verdict, or the empty string when the output has no
# such line. Matched with a trailing-space-tolerant pattern because Atlas pads
# the block, and lowercased so a future capitalisation change cannot silently
# stop matching.
atlas_status_line() {
  local file=$1
  sed -n 's/^[[:space:]]*Migration Status:[[:space:]]*\([A-Za-z_]*\).*/\1/p' "$file" |
    head -1 | tr '[:upper:]' '[:lower:]'
}

# atlas_status_field FILE LABEL
#
# One `-- Label: value` field from the status block, or the empty string.
# Atlas writes these as `  -- Pending Files:   3`.
atlas_status_field() {
  local file=$1 label=$2
  sed -n "s/^[[:space:]]*--[[:space:]]*${label}:[[:space:]]*\(.*[^[:space:]]\)[[:space:]]*$/\1/p" \
    "$file" | head -1
}

# atlas_pending_files FILE
#
# The names Atlas lists under its pending block, one per line. Atlas prints
# them as `  -- 20260919123456_thing.sql` lines after the counts. Absent in
# some versions, which is why nothing here depends on finding any: the counts
# decide the verdict, these only make the message actionable.
atlas_pending_files() {
  local file=$1
  sed -n 's/^[[:space:]]*--[[:space:]]*\([0-9][0-9]*_[^[:space:]]*\.sql\)[[:space:]]*$/\1/p' "$file"
}

# classify_atlas_status FILE DECLARED_COUNT
#
# Turns `atlas migrate status` output into the same three-way verdict
# check-store-drift.sh uses: 0 current, 1 behind, 2 unknown. Prints the
# workflow-annotated reason.
#
# DECLARED_COUNT is how many migration files the repository holds. It is what
# separates "one migration pending" from "the revision table is empty and Atlas
# considers the whole history pending" — the distinction this script's header
# explains. Pass 0 to skip that test when the count is genuinely unavailable;
# the verdict is still right, only the message is less specific.
#
# The absence of a verdict line is exit 2 and never exit 0. `atlas migrate
# status` prints that line on every success, so output without one is a
# connection error, an SSM command that never ran, or a truncated log — none of
# which is evidence that production is current. The failure that put this whole
# family of checks in the repository was a tool exiting 0 with no rows and the
# caller reading that as a clean store (#3036), so the mirror image is refused
# here explicitly.
classify_atlas_status() {
  local file=$1 declared=${2:-0}
  local verdict pending executed

  if [[ ! -s $file ]]; then
    echo "::error::Postgres: the status command produced no output, so the store's state is unknown."
    return 2
  fi

  verdict=$(atlas_status_line "$file")
  if [[ -z $verdict ]]; then
    echo "::error::Postgres: no 'Migration Status:' line in the output, so \`atlas migrate status\` did not run."
    echo "::error::Postgres: this is unknown, not current — a store is never called current off the absence of an answer."
    sed '/^$/d' "$file" | sed 's/^/::error::  /' | head -5
    return 2
  fi

  pending=$(atlas_status_field "$file" "Pending Files")
  executed=$(atlas_status_field "$file" "Executed Files")

  case $verdict in
    ok)
      # Atlas omits `Pending Files` at zero in some versions, so an empty
      # field corroborates OK rather than contradicting it.
      if [[ -n $pending && $pending != "0" ]]; then
        echo "::error::Postgres: Atlas reports OK and $pending pending files at once, which cannot both be true."
        return 2
      fi
      # OK describes the directory Atlas read, not this repository. A short
      # executed count with nothing pending means that directory is fully
      # applied and is older than the files this commit declares.
      if [[ $declared -gt 0 && -n $executed && $executed -lt $declared ]]; then
        echo "::error::Postgres: Atlas reports OK with $executed executed files, and this repository declares $declared."
        echo "::error::Postgres: the status was not taken against this commit's migrations. The store is behind."
        return 1
      fi
      if [[ $declared -gt 0 && -n $executed && $executed -gt $declared ]]; then
        echo "::error::Postgres: Atlas reports OK with $executed executed files, and this repository declares $declared."
        echo "::error::Postgres: the counts disagree, so the store's state is unknown."
        return 2
      fi
      echo "Postgres: current — ${executed:-?} migrations executed, none pending."
      return 0
      ;;
    pending)
      : # falls through to the reporting below
      ;;
    *)
      echo "::error::Postgres: Atlas reports migration status '$verdict', which this check does not know how to read."
      echo "::error::Postgres: treating it as unknown rather than guessing. Read the run's output."
      return 2
      ;;
  esac

  # PENDING from here down.
  if [[ $declared -gt 0 && -n $pending && $pending == "$declared" ]]; then
    echo "::error::Postgres: Atlas reports ALL $declared migrations pending, which means its revision table is empty."
    echo "::error::Postgres: do NOT apply from here — it would try to re-create objects that already exist."
    echo "::error::Postgres: this is a broken revision table, not a store one migration behind. See run-db-migrations.sh."
    return 1
  fi

  echo "::error::Postgres is behind this repository: ${pending:-some} of $declared migrations pending."
  atlas_pending_files "$file" | sed 's/^/::error::  pending: /'
  echo "::error::Postgres: apply with infra/tools/run-db-migrations.sh packages/database --apply from a laptop with AWS credentials, on a checkout of origin/main, or with the DB Migrate (manual) workflow, which runs the same script. Read the pending list first."
  return 1
}

# ---------------------------------------------------------------------------
# Sourcing stops here. Below this line the script talks to production.
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0
fi

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/postgres-drift-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

DB_DIR="$REPO/packages/database"
MIGRATIONS="$DB_DIR/atlas/migrations"

echo "== Postgres migrations =="

# An empty declared list is a check that did not happen, never a pass — the
# same invariant require_declarations holds in check-store-drift.sh. A renamed
# directory would otherwise make every comparison below vacuous.
DECLARED=$(find "$MIGRATIONS" -maxdepth 1 -name '*.sql' -type f 2>/dev/null | wc -l | tr -d ' ')
if [[ ${DECLARED:-0} -eq 0 ]]; then
  echo "::error::Postgres: no migrations found in $MIGRATIONS, so there is nothing to compare."
  echo "::error::Postgres: this is a broken check, not a clean store."
  exit 2
fi
echo "declared: $DECLARED migration files"

# No --apply. The script is a status-only dry run without it, and this file
# never passes it — the grep in tests/check-postgres-drift.test.sh asserts that.
if ! bash "$HERE/run-db-migrations.sh" "$DB_DIR" > "$WORK/status.txt" 2>&1; then
  echo "::error::Postgres: the status command failed, so the store's state is unknown."
  echo "::error::Postgres: usual causes are the SSM command not reaching the node and a credential that no longer resolves the cluster endpoint."
  sed '/^$/d' "$WORK/status.txt" | sed 's/^/::error::  /' | tail -10
  exit 2
fi

cat "$WORK/status.txt"
echo
classify_atlas_status "$WORK/status.txt" "$DECLARED"
exit $?
