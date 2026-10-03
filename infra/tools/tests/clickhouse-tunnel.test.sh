#!/usr/bin/env bash
#
# Holds clickhouse-tunnel.sh to the one decision it makes: how a CI runner
# reaches ClickHouse through the app node (#5395, ADR-295).
#
# No pull request job opens these tunnels, because they reach production. The
# first real run of the https branch is the first migration-gate after
# Parameter Store points CLICKHOUSE_URL at ClickHouse Cloud, and a failure
# there blocks the deploy. So the decision is tested here, on every pull
# request, and the wiring that carries it out is held by the string checks at
# the end.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOLS=$(cd "$HERE/.." && pwd)
REPO=$(cd "$TOOLS/../.." && pwd)

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
  if [[ $want == "$got" ]]; then pass; else fail "$label: wanted '$want', got '$got'"; fi
}

contains() {
  local haystack=$1 needle=$2 label=$3
  case "$haystack" in
    *"$needle"*) pass ;;
    *) fail "$label: expected to find: $needle" ;;
  esac
}

lacks() {
  local haystack=$1 needle=$2 label=$3
  case "$haystack" in
    *"$needle"*) fail "$label: expected not to find: $needle" ;;
    *) pass ;;
  esac
}

# shellcheck source=../clickhouse-tunnel.sh
. "$TOOLS/clickhouse-tunnel.sh"

# plan URL LOCAL_PORT: the four lines joined by spaces, or "refused <stderr>".
plan() {
  local out err code
  err=$(mktemp)
  out=$(clickhouse_tunnel "$1" "$2" 2>"$err")
  code=$?
  if [[ $code -ne 0 ]]; then
    printf 'refused %s' "$(cat "$err")"
  else
    printf '%s' "$out" | tr '\n' ' ' | sed 's/ $//'
  fi
  rm -f "$err"
}

# --- the node: today's answer, whatever the URL says ------------------------

expect_eq "mode=node host= port=8123 url=http://127.0.0.1:8123/" \
  "$(plan "http://127.0.0.1:8123" 8123)" \
  "http on the node forwards 8123 and points at loopback, as before"
expect_eq "mode=node host= port=8123 url=http://127.0.0.1:18123/" \
  "$(plan "http://127.0.0.1:8123/" 18123)" \
  "http uses the caller's local port"
expect_eq "mode=node host= port=8123 url=http://127.0.0.1:8123/" \
  "$(plan "http://localhost:9000/oxagen" 8123)" \
  "http always means the node's 8123, as the action always did"

# --- ClickHouse Cloud: through the node to the real host --------------------

expect_eq "mode=remote host=abc123.us-east-1.aws.clickhouse.cloud port=8443 url=https://abc123.us-east-1.aws.clickhouse.cloud:8123/" \
  "$(plan "https://abc123.us-east-1.aws.clickhouse.cloud:8443" 8123)" \
  "https forwards to the Cloud host and keeps its name for TLS"
expect_eq "mode=remote host=abc123.us-east-1.aws.clickhouse.cloud port=8443 url=https://abc123.us-east-1.aws.clickhouse.cloud:8123/" \
  "$(plan "https://abc123.us-east-1.aws.clickhouse.cloud:8443/" 8123)" \
  "a trailing slash reads the same"
expect_eq "mode=remote host=ch.example.com port=443 url=https://ch.example.com:18443/" \
  "$(plan "https://ch.example.com" 18443)" \
  "https with no port means 443, the port the client would use"
expect_eq "mode=remote host=ch.example.com port=8443 url=https://ch.example.com:8123/oxagen?max_execution_time=60" \
  "$(plan "https://ch.example.com:8443/oxagen?max_execution_time=60" 8123)" \
  "the path (the database) and the query (settings) survive; only the port changes"
expect_eq "mode=remote host=ch.example.com port=8443 url=https://ch.example.com:8123?x=1" \
  "$(plan "https://ch.example.com:8443?x=1" 8123)" \
  "a query with no path keeps its place"
expect_eq "mode=remote host=ch.example.com port=8443 url=https://default:p%40ss@ch.example.com:8123/" \
  "$(plan "https://default:p%40ss@ch.example.com:8443" 8123)" \
  "user info in the URL survives"

# --- refused -------------------------------------------------------------------

for bad in \
  "https://127.0.0.1:8443" \
  "https://[::1]:8443" \
  "https://localhost:8443" \
  "https://ch.example.com:port" \
  "https://ch.example.com:70000" \
  "https://:8443" \
  "tcp://ch.example.com:9440" \
  "ch.example.com:8443" \
  ""
do
  case "$(plan "$bad" 8123)" in
    refused*) pass ;;
    *) fail "refuses '$bad'" ;;
  esac
done

case "$(plan "https://ch.example.com:8443" 0)" in
  refused*) pass ;;
  *) fail "refuses local port 0" ;;
esac
case "$(plan "https://ch.example.com:8443" abc)" in
  refused*) pass ;;
  *) fail "refuses a local port that is not a number" ;;
esac

# A refusal must not echo the URL, which can carry a credential.
lacks "$(plan "https://user:hunter2@127.0.0.1:8443" 8123)" "hunter2" \
  "a refusal does not repeat the URL"

# Run as a script, it takes the same two arguments.
expect_eq "mode=node" "$(bash "$TOOLS/clickhouse-tunnel.sh" "http://127.0.0.1:8123" 8123 | head -n 1)" \
  "the script runs the same decision"
bash "$TOOLS/clickhouse-tunnel.sh" "http://127.0.0.1:8123" >/dev/null 2>&1
expect_eq 2 "$?" "the script refuses a missing argument"

# --- the wiring ----------------------------------------------------------------
#
# The decision above is worth nothing to a caller that stopped asking for it.
# These are string checks, for the reason migration-gate.test.sh gives: a
# deleted step fails nothing at run time until the day it is needed.

ACTION="$REPO/.github/actions/open-store-tunnels/action.yml"
STORE_MIGRATE="$REPO/.github/workflows/store-migrate.yml"

for workflow in "$ACTION" "$STORE_MIGRATE"; do
  name=$(basename "$(dirname "$workflow")")/$(basename "$workflow")
  if [[ ! -f $workflow ]]; then
    fail "$name is gone"
    continue
  fi
  text=$(cat "$workflow")
  contains "$text" "infra/tools/clickhouse-tunnel.sh" "$name decides through clickhouse-tunnel.sh"
  contains "$text" "AWS-StartPortForwardingSessionToRemoteHost" "$name forwards to a remote host for Cloud"
  contains "$text" "sudo tee -a /etc/hosts" "$name maps the Cloud host to loopback for TLS"
  contains "$text" "CLICKHOUSE_URL=" "$name points CLICKHOUSE_URL at the tunnel"
done

if [[ -f $STORE_MIGRATE ]]; then
  # The pending list and the checks after an apply read the store the apply
  # wrote to. A hardcoded node address read the node while Cloud was migrated.
  lacks "$(cat "$STORE_MIGRATE")" '"http://127.0.0.1:8123/"' \
    "store-migrate.yml reads ClickHouse at CLICKHOUSE_URL, not at a fixed node address"
fi

# --- result --------------------------------------------------------------------

if [[ $FAILED -gt 0 ]]; then
  echo "clickhouse-tunnel: $FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "clickhouse-tunnel: $CASES assertions passed"
