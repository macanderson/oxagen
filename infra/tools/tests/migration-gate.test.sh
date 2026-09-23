#!/usr/bin/env bash
#
# Holds the deploy pipeline to the ordering rule: production carries a
# migration before the code that assumes it starts serving traffic.
#
# WHY A TEST AND NOT JUST THE WORKFLOW
#
# The guarantee this protects has already been lost once, silently, and the way
# it was lost is the reason this file exists. `deploy-node` used to carry
# `needs: [checks, test, migrate]`. The `migrate` job stopped being able to act
# on any event (#1280), was retired (#1341), and the `needs:` went with it. No
# check failed, because a deleted dependency fails nothing — it just stops
# being true. Four production incidents followed: #1275, #2796, #3449, #3692.
#
# So the edge itself is the thing under test. Every assertion below is about a
# line whose DELETION is invisible at runtime: a `needs:` entry, an `if:` that
# keeps the gate on the same skip path as its siblings, a script the gate calls.
# A green pipeline says nothing about any of them.
#
# These are string assertions over YAML rather than a parse. That is deliberate:
# the repository's shell test harness has no YAML parser, and a substring match
# is exactly strong enough for "this edge is present", which is the only claim
# being made. The verdict logic lives in the two drift scripts and is tested
# against their own output in the files beside this one.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOLS=$(cd "$HERE/.." && pwd)
REPO=$(cd "$TOOLS/../.." && pwd)

PIPELINE="$REPO/.github/workflows/pipeline.yml"

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

if [[ ! -f $PIPELINE ]]; then
  echo "migration-gate: .github/workflows/pipeline.yml is gone" >&2
  exit 1
fi
PIPE=$(cat "$PIPELINE")

# --- the gate exists -------------------------------------------------------

contains "$PIPE" "  migration-gate:" "pipeline.yml defines a migration-gate job"

# --- the edge that is the whole point --------------------------------------
#
# The one line that makes every other line in this change matter. Without it
# the gate still runs, still goes red, and still ships the deploy anyway.

contains "$PIPE" "needs: [checks, test, migration-gate]" \
  "deploy-node waits on migration-gate — this is the ordering guarantee itself"

# --- the gate asks all three stores ----------------------------------------
#
# api and app read Postgres, ClickHouse and Neo4j. A gate that checked two of
# the three would be a gate with a documented hole, and the store it is most
# tempting to drop is Postgres, whose check is the one that did not exist.

contains "$PIPE" "infra/tools/apply-postgres-migrations.sh" \
  "the gate brings Postgres to the head of the directory"
contains "$PIPE" "infra/tools/check-store-drift.sh" \
  "the gate asks ClickHouse and Neo4j whether they carry the committed schema"

for script in apply-postgres-migrations.sh check-postgres-drift.sh check-store-drift.sh; do
  if [[ -x "$TOOLS/$script" || -f "$TOOLS/$script" ]]; then
    pass
  else
    fail "the gate calls infra/tools/$script, which does not exist"
  fi
done

# --- the gate applies only through its guarded paths ----------------------
#
# Mac decided on 2026-09-23 that CI applies production migrations (#3653). The
# gate applies, but only through two paths whose refusals are tested:
#
#   Postgres     apply-postgres-migrations.sh, which refuses an unreadable
#                store and an empty revision table. Its own test holds that.
#   the stores   db-migrate.ts, only when check-store-drift.sh answered behind
#                (1), never on unknown (2), and always followed by a re-check.
#
# A raw `atlas migrate apply` or `run-db-migrations.sh --apply` in the gate
# would skip the Postgres refusals, so neither may appear outside an echo.
#
# Scoped to the gate's own YAML block, because the file's prose discusses
# applying at length and `manual-app-deploy` below it legitimately deploys.
# Comments are then stripped, the same way check-postgres-drift.test.sh strips
# them, so a comment about applying never reads as the gate applying.
#
# Only whole comment lines are dropped, never a trailing `#`: the summary the
# gate writes contains `echo "### Deploy blocked..."`, and cutting at the first
# hash would silently empty the lines the assertions below read.
# The filter is folded into the awk rather than piped through grep so the test
# depends on nothing a CI runner might not carry.
GATE=$(awk '
  /^  migration-gate:/            { f = 1 }
  f && /^  [a-z-]+:$/ && !/^  migration-gate:/ { exit }
  f && $0 !~ /^[[:space:]]*#/     { print }
' "$PIPELINE")

if [[ -z $GATE ]]; then
  fail "could not isolate the migration-gate block — the assertions below prove nothing"
else
  pass
  case "$GATE" in
    *"migrate apply"*)
      fail "the gate runs 'atlas migrate apply' itself — Postgres applies only through apply-postgres-migrations.sh" ;;
    *) pass ;;
  esac
  # Judged on the lines that run something. The blocked-deploy summary the
  # gate writes names the apply command for the operator to run by hand, and
  # an `echo` of that command applies nothing.
  GATE_COMMANDS=$(printf '%s\n' "$GATE" | awk '$1 != "echo"')
  case "$GATE_COMMANDS" in
    *"--apply"*)
      fail "the gate passes --apply itself — Postgres applies only through apply-postgres-migrations.sh" ;;
    *) pass ;;
  esac

  # The store runner's step, and the line before it, which must be its guard.
  store_guard=$(printf '%s\n' "$GATE" | awk '/db-migrate\.ts/ { print prev } { prev = $0 }')
  if [[ -z $store_guard ]]; then
    fail "the gate never applies ClickHouse and Neo4j"
  elif [[ $store_guard == *"steps.stores.outputs.code == '1'"* ]]; then
    pass
  else
    fail "db-migrate.ts must run only when the stores answered behind (1), got guard: $store_guard"
  fi
  contains "$GATE" "id: stores_after" "a store apply is followed by a fresh check"
  contains "$GATE" "steps.stores_after.outputs.code || steps.stores.outputs.code" \
    "the decision reads the re-check, not the apply's exit code"

  # The gate must fail the run rather than merely annotate it. A step that
  # reports drift and exits 0 is the silent-success shape this whole family of
  # checks exists to refuse.
  contains "$GATE" "exit 1" "the gate fails the run when a store is not ready"

  # Unknown must block as well as behind. The default is what enforces it: an
  # empty step output means the step never ran, and that is not evidence the
  # schema is ready.
  contains "$GATE" 'pg=${PG:-2}' "an unread Postgres answer defaults to unknown, not current"
  contains "$GATE" 'stores=${STORES:-2}' "an unread store answer defaults to unknown, not current"

  # A blocked deploy has to tell its reader what to do next, or the gate is an
  # obstacle rather than a control.
  contains "$GATE" "run-db-migrations.sh packages/database --apply" \
    "the failure names the script that applies Postgres"
  contains "$GATE" "DB Migrate (manual)" "the failure names the dispatch that runs the same script"
  contains "$GATE" "Store Migrate (manual)" "the failure names the workflow that applies the stores"
fi

# --- the gate skips with its siblings, never around them -------------------
#
# deploy-node needs checks, test AND migration-gate. If the gate's `if:` did not
# match the other two, a superseded commit would leave deploy-node waiting on a
# job that never runs. Sharing the preflight condition is what keeps the skip
# cascade coherent.

contains "$PIPE" "needs.preflight.outputs.proceed == 'true'" \
  "the gate is on the same preflight skip path as checks and test"

# ---------------------------------------------------------------------------

if [[ $FAILED -gt 0 ]]; then
  echo "migration-gate: $FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "migration-gate: $CASES assertions passed"
