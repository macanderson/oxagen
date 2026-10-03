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

# run SMOKE SMOKE_CODE HEALTH_EXIT [REPLY]: the smoke request answers
# SMOKE_CODE ("000" for no answer) with the body REPLY, and the health check
# after it exits HEALTH_EXIT.
run() {
  SMOKE=$1 SMOKE_CODE=$2 HEALTH_EXIT=$3 REPLY_BODY=${4:-} FN="$work/serves.sh" ARGS="$work/args" bash -c '
    log() { :; }
    sleep() { :; }
    curl() {
      local arg out="" prev=""
      for arg in "$@"; do
        [[ $prev == "-o" ]] && out=$arg
        prev=$arg
      done
      for arg in "$@"; do
        if [[ $arg == "%{http_code}" ]]; then
          printf "%s\n" "$@" > "$ARGS"
          [[ -n $out && $out != /dev/null ]] && printf "%s" "$REPLY_BODY" > "$out"
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

# --- the body it expects --------------------------------------------------

LIST_SMOKE='{"method":"POST","path":"/mcp","headers":{"Content-Type":"application/json"},"body":"{}","expect":"\"inputSchema\""}'
if run "$LIST_SMOKE" 200 0 'data: {"result":{"tools":[{"name":"x","inputSchema":{}}]}}'; then pass; else fail "a reply that carries the expected text should deploy"; fi
if run "$LIST_SMOKE" 200 0 'data: {"error":{"code":-32603,"message":"Cannot read properties of undefined"}}'; then
  fail "an MCP error inside a 200 should roll back (#4829)"
else
  pass
fi

# --- the request it sends -------------------------------------------------

run "$MCP_SMOKE" 200 0
args=$(cat "$work/args" 2>/dev/null || true)
for want in "POST" "Content-Type: application/json" "Authorization: Bearer deploy-smoke" \
  '{"jsonrpc":"2.0","id":1,"method":"initialize"}' "http://127.0.0.1:4100/mcp"; do
  if grep -qxF -- "$want" <<<"$args"; then pass; else fail "the smoke request should carry '$want'"; fi
done

# --- the rollback removes the failed release -------------------------------

if grep -q 'rm -rf "${release:?}"' "$SCRIPT"; then pass; else fail "a rolled-back release should be removed so it does not count toward the kept releases"; fi

# With no release to roll back to, `current` must stop naming the failed one,
# or the next deploy takes it as its rollback target.
no_previous=$(sed -n '/no previous release to roll back to/,/^  fi$/p' "$SCRIPT")
if grep -q 'rm -f "$CURRENT"' <<<"$no_previous"; then pass; else fail "a failed deploy with no rollback target should clear current"; fi

# --- the swap lets the current container finish its requests (#5318) -----

for fn in port_released retire_current finish_draining; do
  sed -n "/^$fn() {\$/,/^}\$/p" "$SCRIPT" > "$work/$fn.sh"
  if [[ ! -s $work/$fn.sh ]]; then
    echo "FAIL: deploy-service.sh defines no $fn()" >&2
    exit 1
  fi
done

# swap FN INSPECT_RC CURL_RC OVERLAP DRAINING: runs FN against a docker that
# records each call in $work/calls, and a curl that always exits CURL_RC (7
# is a refused connection). Prints the draining name FN leaves behind and
# exits with FN's status.
swap() {
  : > "$work/calls"
  FN=$1 INSPECT_RC=$2 CURL_RC=$3 OVERLAP=$4 DRAINING=${5:-} CALLS="$work/calls" DIR="$work" bash -c '
    log() { :; }
    sleep() { :; }
    curl() { return "$CURL_RC"; }
    docker() {
      echo "docker $*" >> "$CALLS"
      [[ $1 == inspect ]] && return "$INSPECT_RC"
      return 0
    }
    timeout() { echo "timeout $1" >> "$CALLS"; shift; "$@"; }
    CONTAINER=oxagen-app release_id=R1 port=3000 health_path=/
    PORT_RELEASE_SECONDS=2 drain_seconds=120 overlap=$OVERLAP draining=$DRAINING
    for f in port_released retire_current finish_draining; do
      # shellcheck disable=SC1090 # the functions extracted above
      . "$DIR/$f.sh"
    done
    "$FN" && rc=0 || rc=$?
    printf "%s" "$draining"
    exit "$rc"
  ' 2>/dev/null
}
calls() { cat "$work/calls"; }

if swap port_released 0 7 true >/dev/null; then pass; else fail "a refused connection should read as a released port"; fi
if swap port_released 0 0 true >/dev/null; then fail "an HTTP answer should read as a port still held"; else pass; fi
if swap port_released 0 28 true >/dev/null; then fail "a timeout should read as a port still held"; else pass; fi

# A Next server closes its port on SIGTERM and keeps running.
left=$(swap retire_current 0 7 true)
want=$'docker inspect oxagen-app\ndocker update --restart=no oxagen-app\ndocker rename oxagen-app oxagen-app-draining-R1\ndocker kill --signal TERM oxagen-app-draining-R1'
if [[ $(calls) == "$want" ]]; then pass; else fail "retire should stop restarts, rename, then send SIGTERM, and nothing else; got: $(calls)"; fi
if [[ $left == oxagen-app-draining-R1 ]]; then pass; else fail "retire should leave the renamed container draining, got '$left'"; fi

# A service with no SIGTERM handler keeps answering, so it gets SIGKILL.
swap retire_current 0 0 true >/dev/null
if grep -qx "docker kill oxagen-app-draining-R1" <<<"$(calls)"; then pass; else fail "a container that keeps the port should get SIGKILL"; fi
if [[ $(grep -n "kill --signal TERM" <<<"$(calls)" | cut -d: -f1) -lt $(grep -nx "docker kill oxagen-app-draining-R1" <<<"$(calls)" | cut -d: -f1) ]]; then
  pass
else
  fail "SIGTERM should come before SIGKILL"
fi

# With no memory for both copies, the old one goes before the new one starts.
left=$(swap retire_current 0 7 false)
if [[ -z $left ]] && grep -qx "docker rm -f oxagen-app-draining-R1" <<<"$(calls)"; then pass; else fail "with no overlap the old container should be removed before the swap"; fi
if grep -qx "timeout 2" <<<"$(calls)"; then pass; else fail "with no overlap the old container should get the port wait to finish"; fi

# No current container: nothing to retire.
left=$(swap retire_current 1 7 true)
if [[ -z $left && $(calls) == "docker inspect oxagen-app" ]]; then pass; else fail "with no current container retire should do nothing; got: $(calls)"; fi

# The drain waits for the old container, then removes it.
left=$(swap finish_draining 0 7 true oxagen-app-draining-R1)
want=$'timeout 120\ndocker wait oxagen-app-draining-R1\ndocker rm -f oxagen-app-draining-R1'
if [[ $(calls) == "$want" && -z $left ]]; then pass; else fail "the drain should wait up to drain_seconds, then remove the container; got: $(calls)"; fi
swap finish_draining 0 7 true "" >/dev/null
if [[ ! -s $work/calls ]]; then pass; else fail "with nothing draining the drain should do nothing"; fi

# The order in the script: retire before the first start, and the drain only
# after the node lock is released, on both the deployed and the rolled-back path.
if grep -qx 'retire_current' "$SCRIPT" \
  && [[ $(grep -nx 'retire_current' "$SCRIPT" | cut -d: -f1) -lt $(grep -nx 'start_container "$release"' "$SCRIPT" | cut -d: -f1) ]]; then
  pass
else
  fail "the current container should retire before the new one starts"
fi
if [[ $(grep -cx '  flock -u 201' "$SCRIPT") -eq 1 && $(grep -cx 'flock -u 201' "$SCRIPT") -eq 1 \
  && $(grep -cE '^ *finish_draining$' "$SCRIPT") -eq 2 ]]; then
  pass
else
  fail "the drain should follow the lock release on the rollback path and on the deployed path"
fi
if grep -q -- '--overlap' "$SCRIPT"; then pass; else fail "the memory budget should count both copies during the drain"; fi

# --- result ---------------------------------------------------------------

if [[ $FAILED -gt 0 ]]; then
  echo "deploy-service-smoke: $FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "deploy-service-smoke: $CASES assertions passed"
