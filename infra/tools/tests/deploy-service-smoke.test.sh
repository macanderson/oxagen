#!/usr/bin/env bash
#
# Holds deploy-service.sh's smoke request to what it exists to catch.
#
# On 2026-09-30 mcp answered /health inside the deploy's grace window,
# deployed green, and ran its heap out on the first POST /mcp (#4829). The
# process never exited, so nothing restarted it. `serves` sends the manifest's
# smoke request and asks for the health route again. It runs here against a
# stub curl, because the real one needs a node and a container.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../node/deploy-service.sh"

FAILED=0
CASES=0

pass() { CASES=$((CASES + 1)); }
fail() {
  CASES=$((CASES + 1))
  FAILED=$((FAILED + 1))
  echo "FAIL: $1" >&2
}

command -v jq >/dev/null || { echo "deploy-service-smoke: jq is required" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The function exactly as the script defines it, so the test cannot drift from
# a copy.
sed -n '/^serves() {$/,/^}$/p' "$SCRIPT" > "$work/serves.sh"
if [[ ! -s $work/serves.sh ]]; then
  echo "FAIL: deploy-service.sh defines no serves()" >&2
  exit 1
fi

# run SMOKE SMOKE_CODE HEALTH_EXIT: the smoke request answers SMOKE_CODE
# ("000" for no answer), and the health check after it exits HEALTH_EXIT.
run() {
  SMOKE=$1 SMOKE_CODE=$2 HEALTH_EXIT=$3 FN="$work/serves.sh" ARGS="$work/args" bash -c '
    log() { :; }
    sleep() { :; }
    curl() {
      local arg
      for arg in "$@"; do
        if [[ $arg == "%{http_code}" ]]; then
          printf "%s\n" "$@" > "$ARGS"
          printf "%s" "$SMOKE_CODE"
          [[ $SMOKE_CODE == 000 ]] && return 7
          return 0
        fi
      done
      return "$HEALTH_EXIT"
    }
    SERVICE=mcp port=4100 health_path=/health smoke=$SMOKE
    # shellcheck disable=SC1090 # the function extracted above
    . "$FN"
    serves
  ' >/dev/null 2>&1
}

MCP_SMOKE='{"method":"POST","path":"/mcp","headers":{"Content-Type":"application/json","Authorization":"Bearer deploy-smoke"},"body":"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}"}'

# --- no smoke request -----------------------------------------------------

if run "" 000 7; then pass; else fail "a manifest without a smoke request should deploy on health alone"; fi

# --- answered -------------------------------------------------------------

if run "$MCP_SMOKE" 200 0; then pass; else fail "a 200 followed by a healthy check should deploy"; fi
if run "$MCP_SMOKE" 401 0; then pass; else fail "a 401 is an answer, and should deploy"; fi

# --- not served -----------------------------------------------------------

if run "$MCP_SMOKE" 000 0; then fail "no answer to the smoke request should roll back"; else pass; fi
if run "$MCP_SMOKE" 503 0; then fail "a 503 should roll back"; else pass; fi
if run "$MCP_SMOKE" 200 7; then fail "a health route that stops answering after the request should roll back"; else pass; fi

# --- the request it sends -------------------------------------------------

run "$MCP_SMOKE" 200 0
args=$(cat "$work/args" 2>/dev/null || true)
for want in "POST" "Content-Type: application/json" "Authorization: Bearer deploy-smoke" \
  '{"jsonrpc":"2.0","id":1,"method":"initialize"}' "http://127.0.0.1:4100/mcp"; do
  if grep -qxF -- "$want" <<<"$args"; then pass; else fail "the smoke request should carry '$want'"; fi
done

# --- the rollback removes the failed release -------------------------------

if grep -q 'rm -rf "${release:?}"' "$SCRIPT"; then pass; else fail "a rolled-back release should be removed so it does not count toward the kept releases"; fi

# --- result ---------------------------------------------------------------

if [[ $FAILED -gt 0 ]]; then
  echo "deploy-service-smoke: $FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "deploy-service-smoke: $CASES assertions passed"
