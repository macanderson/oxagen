#!/usr/bin/env bash
#
# Reads the script run-clickhouse-migrations.sh sends to the node, without an
# account to run it in. What the node executes is rendered text, so the text
# is the thing under test: where the credentials come from, that nothing
# prints them, and that a dry run carries no line that could apply.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOLS=$(cd "$HERE/.." && pwd)

# Sourcing returns before the script's own body runs — see its source guard.
# shellcheck source=infra/tools/run-clickhouse-migrations.sh
source "$TOOLS/run-clickhouse-migrations.sh"

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

lacks() {
  local haystack=$1 needle=$2 label=$3
  case "$haystack" in
    *"$needle"*) fail "$label — expected NOT to find: $needle" ;;
    *) pass ;;
  esac
}

# --- the rendered remote script -------------------------------------------

DRY=$(render_remote_clickhouse_migration "test-bucket" "node:22-alpine" "0")

contains "$DRY" "s3://test-bucket/_deploy/clickhouse-migrations.tgz" "dry run: downloads from the given bucket"
contains "$DRY" "/oxagen/production/" "dry run: reads the platform's own configuration prefix"
contains "$DRY" "param CLICKHOUSE_PASSWORD" "dry run: reads the password on the node"
lacks "$DRY" "set -x" "dry run: never traces, so the password cannot be echoed"
# shellcheck disable=SC2016  # the single quotes are the point: this is the
# literal text that must be absent from the script under test.
lacks "$DRY" 'echo "$CLICKHOUSE_PASSWORD' "dry run: never prints the password"
contains "$DRY" "FROM _migrations" "dry run: reads the ledger the runner keeps"
lacks "$DRY" "node migrate.mjs" "dry run: carries no line that applies"
lacks "$DRY" "docker run" "dry run: starts no container"
contains "$DRY" "dry run: nothing was applied" "dry run: says so"
lacks "$DRY" "__" "dry run: no placeholder survives"

APPLY=$(render_remote_clickhouse_migration "test-bucket" "node:22-alpine" "1")

contains "$APPLY" "node migrate.mjs" "apply: runs the bundled runner"
contains "$APPLY" "--network host" "apply: the container reaches the node's own loopback"
contains "$APPLY" "-e CLICKHOUSE_PASSWORD " "apply: the password crosses into the container by name, not by value"
lacks "$APPLY" "-e CLICKHOUSE_PASSWORD=" "apply: the password is not put on the docker command line"
contains "$APPLY" "/opt/oxagen/clickhouse-migrate:/work:ro" "apply: the staged bundle is mounted read-only"
contains "$APPLY" " node:22-alpine node migrate.mjs" "apply: runs in the given image"
contains "$APPLY" "status after apply" "apply: reports the state it left behind"
lacks "$APPLY" "__" "apply: no placeholder survives"

# --- argument validation ----------------------------------------------------

if render_remote_clickhouse_migration "" "node:22-alpine" "0" >/dev/null 2>&1; then
  fail "an empty bucket renders"
else
  pass
fi

if render_remote_clickhouse_migration "test-bucket" "node:22-alpine" >/dev/null 2>&1; then
  fail "a missing argument renders"
else
  pass
fi

echo "$((CASES - FAILED))/$CASES passed"
[[ $FAILED -eq 0 ]]
