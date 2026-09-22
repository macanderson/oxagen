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

contains "$PIPE" "infra/tools/check-postgres-drift.sh" \
  "the gate asks Postgres whether Aurora is at the head of the directory"
contains "$PIPE" "infra/tools/check-store-drift.sh" \
  "the gate asks ClickHouse and Neo4j whether they carry the committed schema"

for script in check-postgres-drift.sh check-store-drift.sh; do
  if [[ -x "$TOOLS/$script" || -f "$TOOLS/$script" ]]; then
    pass
  else
    fail "the gate calls infra/tools/$script, which does not exist"
  fi
done

# --- the gate never applies ------------------------------------------------
#
# The rule it must not break, stated in CLAUDE.md: "Apply production migrations
# through the manual db-migrate.yml and store-migrate.yml workflows. Deployment
# does not apply them." #3653 is the issue filed when a generated workflow broke
# that rule. A gate that grew an apply would be the same mistake wearing a name
# nobody would think to check.
#
# Scoped to the gate's own YAML block, because the file's prose discusses
# applying at length and `manual-app-deploy` below it legitimately deploys.
# Comments are then stripped, the same way check-postgres-drift.test.sh strips
# them: a comment saying the gate must never apply would otherwise read as the
# gate applying, and a test that fails on its own explanation gets deleted.
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
      fail "the gate runs 'migrate apply' — deployment must not apply migrations (CLAUDE.md, #3653)" ;;
    *) pass ;;
  esac
  case "$GATE" in
    *"--apply"*)
      fail "the gate passes --apply — deployment must not apply migrations (CLAUDE.md, #3653)" ;;
    *) pass ;;
  esac
  case "$GATE" in
    *"db-migrate.ts"*)
      fail "the gate invokes the store migration runner — it is read-only by construction" ;;
    *) pass ;;
  esac

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
  contains "$GATE" "DB Migrate (manual)" "the failure names the workflow that applies Postgres"
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
