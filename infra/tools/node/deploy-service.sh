#!/usr/bin/env bash
#
# Install a published artifact as a running service, and put the previous one
# back if the new one does not answer.
#
#   deploy-service.sh <service>
#
# This runs *on the node*, invoked by the `oxagen-deploy-service` SSM document,
# which is the only SSM document the CI roles may send. That split is the point
# of the file existing at all: the migration deploys drove AWS-RunShellScript,
# and handing a GitHub Actions role permission to send AWS-RunShellScript to
# this instance would be handing it root on the box that also runs Postgres,
# Neo4j and ClickHouse. CI gets "deploy the service called X" instead, and the
# privilege lives here where it can be read.
#
# What runs is not passed in either. The artifact carries `oxagen-run.json` at
# its root describing its own image, port, command and configuration, so a
# service that changes how it starts changes the repository that owns it —
# not this script, and not the SSM document, which would otherwise mean an
# infrastructure apply for an application decision.
#
# The rollback is the part that earns its complexity. These deploys now happen
# automatically on merge, with nobody necessarily watching. Without a rollback,
# the first merge that builds green and boots red takes the site down until a
# human notices; with one, it takes the site down for as long as the health
# check needs to fail, and the workflow goes red with the reason.

set -euo pipefail

# node.env carries this node's own account-specific values — the bucket and
# region differ between the old account's node and the new account's, and
# this one script is installed on both by install-node-scripts.sh. Its
# absence (an old-account node this repository hasn't touched since the
# new account existed) falls back to the values that were hardcoded here
# before node.env existed, so an untouched node keeps working unchanged.
[[ -f /opt/oxagen/bin/node.env ]] && source /opt/oxagen/bin/node.env

readonly DEPLOY_BUCKET="${DEPLOY_BUCKET:-oxagen-deploy-578673726240}"
readonly REGION="${REGION:-us-east-1}"
# json-file is the old account's node — unchanged behaviour there. The new
# account's node.env sets this to awslogs, because that node's IAM role
# (unlike the old node's) is actually granted logs:PutLogEvents on
# /oxagen-app/*; switching the default here would break the old node's
# containers on their next deploy with no permission to write anywhere.
readonly LOG_DRIVER="${LOG_DRIVER:-json-file}"
readonly LOG_GROUP_PREFIX="${LOG_GROUP_PREFIX:-/oxagen-app}"
readonly EXTRA_CA_CERT="${EXTRA_CA_CERT:-}"
readonly ROOT=/opt/oxagen/services
readonly KEEP_RELEASES=3

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <service>" >&2
  exit 2
fi

readonly SERVICE=$1

# Belt and braces with the SSM document's `allowedPattern`. That pattern is the
# real control — a malformed value is rejected before this instance is asked to
# do anything — but this script is also runnable by hand, and a path assembled
# from an unvalidated argument is how `rm -rf` finds the wrong directory.
if [[ ! $SERVICE =~ ^[a-z][a-z0-9-]{0,30}$ ]]; then
  echo "error: '$SERVICE' is not a valid service name" >&2
  exit 2
fi

readonly SERVICE_DIR=$ROOT/$SERVICE
readonly RELEASES=$SERVICE_DIR/releases
readonly CURRENT=$SERVICE_DIR/current
readonly CONTAINER=oxagen-$SERVICE

log() { printf '==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Space, before anything is written.
#
# The prune at the bottom runs only after a HEALTHY deploy, which is right --
# a failed deploy must not delete the candidates you would roll back to. The
# consequence is that a run of failing deploys writes a new release directory
# every attempt and deletes nothing. That is how the 20 GB root volume of
# `oxagen-data` filled on 2026-08-25 and took SSM command execution down with
# it for 8.5 hours, while every public site kept serving so nothing alerted
# (#1305).
#
# Checking here is what turns that into a refusal. What this may delete is
# only what the post-deploy prune would already delete: releases BEYOND the
# retention window. `current` and the newest KEEP_RELEASES are never touched,
# so the rollback guarantee is exactly as it was.
#
# The floor is a variable because the right number is per-node -- 3 GB clears
# the largest artifact this repository ships with room to unpack it, and a node
# with a bigger disk or a bigger service should say so rather than edit this.
# ---------------------------------------------------------------------------

readonly MIN_FREE_MB="${MIN_FREE_MB:-3072}"

# -P for POSIX output (one line per filesystem, never wrapped), -m for MB.
free_mb() { df -Pm "$ROOT" | awk 'NR==2 {print $4}'; }

# shellcheck disable=SC2012 # names here are timestamps this script generates,
# so they sort lexicographically and contain nothing `ls` would mangle.
prune_beyond_retention() {
  [[ -d $RELEASES ]] || return 0
  ls -1 "$RELEASES" | sort -r | tail -n "+$((KEEP_RELEASES + 1))" | while read -r old; do
    [[ $RELEASES/$old == "$(readlink -f "$CURRENT" 2>/dev/null)" ]] && continue
    log "reclaiming space: pruning release $old (already beyond the $KEEP_RELEASES kept)"
    rm -rf "${RELEASES:?}/$old"
  done
}

if [[ $(free_mb) -lt $MIN_FREE_MB ]]; then
  log "only $(free_mb) MB free under $ROOT (want $MIN_FREE_MB) — pruning beyond the retention window"
  prune_beyond_retention
  log "$(free_mb) MB free after pruning"
fi

# What the refusal has to answer is "what is holding the disk", and it did not:
# it printed free megabytes and stopped, so diagnosing a recurrence meant
# sending a shell command to the node to run `du` by hand. Every service's
# footprint and Docker's are two commands, and they belong in the failure that
# needs them. Best-effort on purpose -- a diagnostic that fails must not change
# what the deploy does, and `set -e` is in force.
report_space() {
  echo "--- what is using $ROOT ---" >&2
  du -xsh "$ROOT"/* 2>/dev/null | sort -rh >&2 || true
  echo "--- docker ---" >&2
  # `>&2` before `2>/dev/null`, not after: the other order points stdout at a
  # stderr that is already /dev/null and prints nothing at all.
  docker system df >&2 2>/dev/null || true
  echo "--- filesystem ---" >&2
  df -Ph "$ROOT" >&2 || true
}

if [[ $(free_mb) -lt $MIN_FREE_MB ]]; then
  report_space
  fail "only $(free_mb) MB free under $ROOT, need $MIN_FREE_MB. Refusing to unpack: a deploy that fills the root volume takes SSM down with it, and then nothing can reach this node to fix it (#1305)."
fi

# ---------------------------------------------------------------------------
# Fetch and unpack. Nothing that follows touches the running service, so a
# broken artifact fails here with the old one still serving.
# ---------------------------------------------------------------------------

mkdir -p "$RELEASES"
release_id=$(date -u +%Y%m%dT%H%M%SZ)
release=$RELEASES/$release_id
mkdir -p "$release"

tarball=$(mktemp "/tmp/$SERVICE-XXXXXX.tgz")
# Declared before the trap so that the handler can name it unconditionally —
# it is set later, in the configuration block, and a trap that referenced an
# unset variable would abort under `set -u` at the worst possible moment.
config_dump=""

# The release directory is removed on any failure before the swap. After the
# swap it must survive, because it is what `current` points at — so the trap is
# cleared at that moment rather than being conditional here.
#
# One handler covers every temporary this script makes. An earlier revision
# installed a second `trap ... EXIT` around the configuration read, which
# silently replaced this one: a failure after that point left the half-unpacked
# release directory on disk, where the next deploy's prune would treat it as a
# rollback candidate.
cleanup_incoming() { rm -f "$tarball" ${config_dump:+"$config_dump"}; rm -rf "$release"; }
trap cleanup_incoming EXIT

log "fetching s3://$DEPLOY_BUCKET/_deploy/$SERVICE-standalone.tgz"
aws s3 cp "s3://$DEPLOY_BUCKET/_deploy/$SERVICE-standalone.tgz" "$tarball" \
  --region "$REGION" --only-show-errors \
  || fail "no artifact published for '$SERVICE'"

tar -xzf "$tarball" -C "$release" || fail "artifact for '$SERVICE' is not a readable tarball"
rm -f "$tarball"

manifest=$release/oxagen-run.json
[[ -f $manifest ]] || fail "artifact has no oxagen-run.json at its root — see tools/node/README.md"

# ---------------------------------------------------------------------------
# Read the manifest. Every field is validated here rather than at use, so a
# typo in a repository's manifest fails before anything is stopped.
# ---------------------------------------------------------------------------

field() { jq -re "$1" "$manifest" 2>/dev/null || true; }

port=$(field '.port')
image=$(field '.image')
memory=$(field '.memory // "512m"')
health_path=$(field '.health_path // "/"')
config_prefix=$(field '.config_prefix // empty')

[[ $port =~ ^[0-9]{2,5}$ ]] || fail "oxagen-run.json: 'port' must be a number, got '${port:-<missing>}'"
[[ -n $image ]] || fail "oxagen-run.json: 'image' is required"

# An optional request down the service's real path. On 2026-09-30 mcp answered
# its health route inside the grace window, deployed green, and died on its
# first POST /mcp (#4829). The health route alone cannot catch that.
smoke=$(jq -ce '.smoke // empty' "$manifest" 2>/dev/null || true)
if [[ -n $smoke ]]; then
  jq -e '(.method | type == "string")
         and (.path | type == "string" and startswith("/"))
         and ((.headers // {}) | type == "object" and all(.[]; type == "string"))
         and ((.body // "") | type == "string")
         and ((.expect // "") | type == "string")' <<<"$smoke" >/dev/null 2>&1 \
    || fail "oxagen-run.json: 'smoke' needs a method, a path that starts with /, string headers, and a string body and expect"
fi

# An empty command runs the image's own entrypoint, which is what an external
# image such as the engine's wants: its binary is already the entrypoint, and
# naming it again would hand it its own path as an argument. The tarball
# services keep naming theirs, because node:24-alpine's entrypoint is a shell.
jq -e '.command | type == "array"' "$manifest" >/dev/null 2>&1 \
  || fail "oxagen-run.json: 'command' must be an array"
mapfile -t command < <(jq -re '.command[]' "$manifest" 2>/dev/null || true)

# Static environment declared by the artifact. Non-secret by construction —
# anything secret comes from Parameter Store below, because this file ships
# inside a tarball built by a public CI job.
env_args=()
while IFS= read -r pair; do
  [[ -n $pair ]] && env_args+=(-e "$pair")
done < <(jq -re 'if has("env") then (.env | to_entries[] | "\(.key)=\(.value)") else empty end' "$manifest" 2>/dev/null || true)

# ---------------------------------------------------------------------------
# Configuration from Parameter Store.
#
# Read here rather than baked into the artifact so that rotating a secret is a
# parameter write plus a restart, not a rebuild of the application — and so
# that secrets never sit in a tarball produced by a public CI job.
#
# Each value is exported into this script's own environment and passed as
# `-e KEY` with no `=`, which tells Docker to copy the value from its client's
# environment. The two obvious alternatives are both worse:
#
#   `-e KEY=value` puts every secret into the argv of `docker run`, where any
#   process on the box can read it out of /proc while the command runs.
#
#   `--env-file` keeps it out of argv but cannot represent a value containing a
#   newline at all — the format is literal `KEY=VALUE` lines with no quoting or
#   escaping. `/oxagen/production/GITHUB_APP_PRIVATE_KEY` is a PEM. A file
#   would have carried its first line and silently dropped the key.
#
# What this does *not* buy is concealment from `docker inspect`, which reports
# a container's environment however it was set. That is inherent to configuring
# a process through its environment and is not something a deploy script can
# fix; the control that matters there is that reaching this instance requires
# SSM and there is no SSH key.
# ---------------------------------------------------------------------------

if [[ -n $config_prefix ]]; then
  log "reading configuration from $config_prefix"

  # Materialised to a file rather than read straight from a process
  # substitution. A `while ... done < <(cmd)` reports the exit status of the
  # loop, not of `cmd`, so a failed `aws ssm` call there would read as an empty
  # parameter set — a service started with no configuration at all, reported
  # as a successful deploy.
  config_dump=$(mktemp "/tmp/$SERVICE-config-XXXXXX")
  chmod 600 "$config_dump"

  aws ssm get-parameters-by-path \
    --region "$REGION" --path "$config_prefix" --recursive --with-decryption \
    --query 'Parameters[].[Name,Value]' --output json \
  | python3 -c '
import json, sys
params = json.load(sys.stdin)
if not params:
    sys.exit("no parameters found under the configured prefix")
# NUL-separated so a value containing newlines, spaces or quotes survives the
# trip to the shell; the read loop on the other side is the matching half.
out = sys.stdout.buffer
for name, value in params:
    out.write(name.rsplit("/", 1)[-1].encode() + b"\0")
    out.write(value.encode() + b"\0")
' > "$config_dump" || fail "could not read configuration under $config_prefix"

  loaded=0
  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    [[ $key =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
      || fail "parameter '$key' is not a usable environment variable name"
    export "${key}=${value}"
    env_args+=(-e "$key")
    loaded=$((loaded + 1))
  done < "$config_dump"

  # Removed as soon as it is consumed rather than left to the EXIT trap: it
  # holds every decrypted secret the service starts with, and the window it
  # exists for should be the loop above and nothing more.
  rm -f "$config_dump"
  config_dump=""
  log "loaded $loaded parameters"
fi

# ---------------------------------------------------------------------------
# Swap.
#
# Host networking, not a published port, because three of these services reach
# Postgres, Neo4j and ClickHouse over 127.0.0.1 — those are bound to loopback
# on purpose and are not reachable from the bridge network. Caddy is already on
# the host network for the same reason. The service is expected to bind
# loopback itself (HOSTNAME/HOST below); the security group opens no inbound
# port either way, so this is defence in depth rather than the only control.
# ---------------------------------------------------------------------------

# Hold the node-wide lock through replacement, health checks, and rollback.
# A per-service CI lock cannot stop two different services from both spending
# the same remaining RAM. Refuse before changing the current release or container.
command -v flock >/dev/null || fail "flock is required for the node memory budget"
exec 201>/opt/oxagen/service-deploy.lock
flock -w 300 201 || fail "another deployment holds the node memory budget; retry this deployment"
python3 "$(dirname "${BASH_SOURCE[0]}")/ensure-caddy-memory.py" \
  || fail "Caddy memory limit could not be established; the current service is unchanged"
python3 "$(dirname "${BASH_SOURCE[0]}")/memory-budget.py" \
  --service "$SERVICE" --memory "$memory" \
  || fail "node memory preflight refused this deployment; the current service is unchanged"

previous=""
[[ -L $CURRENT ]] && previous=$(readlink -f "$CURRENT")

start_container() {
  local dir=$1
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # The migration named these `oxagen-web-<service>`. Removing that name too
  # means the first run of this script does not leave the old container
  # holding the port while the new one fails to bind it.
  docker rm -f "oxagen-web-$SERVICE" >/dev/null 2>&1 || true

  local log_args=()
  if [[ $LOG_DRIVER == awslogs ]]; then
    log_args=(
      --log-driver awslogs
      --log-opt "awslogs-region=$REGION"
      --log-opt "awslogs-group=$LOG_GROUP_PREFIX/$SERVICE"
      --log-opt awslogs-create-group=true
      --log-opt "awslogs-stream=$SERVICE"
    )
  else
    log_args=(--log-opt max-size=10m --log-opt max-file=3)
  fi

  local tls_args=()
  if [[ -n ${EXTRA_CA_CERT:-} ]]; then
    [[ $EXTRA_CA_CERT == /* && $EXTRA_CA_CERT != *,* && -f $EXTRA_CA_CERT && -r $EXTRA_CA_CERT ]] \
      || fail "EXTRA_CA_CERT must name a readable absolute certificate file"
    tls_args=(--mount "type=bind,source=$EXTRA_CA_CERT,target=/opt/oxagen/extra-ca.pem,readonly" \
      -e NODE_EXTRA_CA_CERTS=/opt/oxagen/extra-ca.pem)
  fi

  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    --network host \
    --memory "$memory" \
    "${log_args[@]}" \
    "${tls_args[@]}" \
    -e NODE_ENV=production \
    -e PORT="$port" \
    -e HOSTNAME=127.0.0.1 \
    -e HOST=127.0.0.1 \
    "${env_args[@]}" \
    -v "$dir:/app" \
    -w /app \
    "$image" ${command[@]+"${command[@]}"} >/dev/null
}

healthy() {
  # Sixty seconds of grace. A cold start on two shared vCPUs is slow, and a
  # deploy that fails because the check was impatient is worse than one that
  # takes another half minute: it rolls back a good release.
  local _attempt
  for _attempt in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$port$health_path"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

# Send the manifest's smoke request, then ask for the health route again. Any
# status below 500 counts as served. The second health check catches a process
# that answers once and then stops, as mcp did: its heap ran out 8 seconds
# after the request, and the process never exited.
serves() {
  [[ -n $smoke ]] || return 0
  local method path body expect code header reply
  method=$(jq -r '.method' <<<"$smoke")
  path=$(jq -r '.path' <<<"$smoke")
  body=$(jq -r '.body // ""' <<<"$smoke")
  expect=$(jq -r '.expect // ""' <<<"$smoke")
  local header_args=()
  while IFS= read -r header; do
    [[ -n $header ]] && header_args+=(-H "$header")
  done < <(jq -r '(.headers // {}) | to_entries[] | "\(.key): \(.value)"' <<<"$smoke")
  reply=$(mktemp)
  code=$(curl -s -o "$reply" -w '%{http_code}' --max-time 30 -X "$method" \
    ${header_args[@]+"${header_args[@]}"} ${body:+--data-raw "$body"} \
    "http://127.0.0.1:$port$path" || true)
  if [[ ! $code =~ ^[1-4][0-9][0-9]$ ]]; then
    echo "error: $SERVICE answered the smoke request $method $path with '${code:-nothing}'" >&2
    rm -f "$reply"
    return 1
  fi
  # An MCP error arrives inside a 200, so a status alone passed a tools/list
  # that failed for every tool (#4829).
  if [[ -n $expect ]] && ! grep -qF -- "$expect" "$reply"; then
    echo "error: $SERVICE answered the smoke request $method $path with $code, without '$expect': $(head -c 300 "$reply")" >&2
    rm -f "$reply"
    return 1
  fi
  rm -f "$reply"
  log "$SERVICE answered the smoke request $method $path with $code"
  sleep 10
  if ! curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$port$health_path"; then
    echo "error: $SERVICE stopped answering $health_path after the smoke request" >&2
    return 1
  fi
}

log "starting $SERVICE from $release_id (image $image, port $port, memory $memory)"
ln -sfn "$release" "$CURRENT"
trap - EXIT
rm -f "$tarball"

start_container "$release"

deployed=false
if healthy; then
  log "$SERVICE is healthy on 127.0.0.1:$port$health_path"
  serves && deployed=true
else
  echo "error: $SERVICE did not answer on 127.0.0.1:$port$health_path within 60s" >&2
fi

if [[ $deployed != true ]]; then
  docker logs --tail 40 "$CONTAINER" 2>&1 | sed 's/^/    /' >&2 || true

  if [[ -n $previous && -d $previous ]]; then
    echo "error: rolling back to $(basename "$previous")" >&2
    ln -sfn "$previous" "$CURRENT"
    start_container "$previous"
    if healthy; then
      echo "error: rolled back; $SERVICE is serving the previous release" >&2
    else
      echo "error: rollback ALSO failed — $SERVICE is down" >&2
    fi
    # The failed release is no rollback candidate. Left on disk, it counted
    # toward the $KEEP_RELEASES kept, and on 2026-09-30 three failed mcp
    # releases plus one that deployed pruned the last one that served.
    rm -rf "${release:?}"
  else
    echo "error: no previous release to roll back to — $SERVICE is down" >&2
  fi

  # Either way this deploy did not succeed, so the SSM command fails and the
  # workflow goes red. A rollback that reported success would be the worst of
  # both: production quietly running the old code while the merge looks shipped.
  exit 1
fi

# ---------------------------------------------------------------------------
# Prune. Only after a healthy deploy — the point of keeping old releases is to
# have something to roll back to, so a failed deploy must never be the run that
# deletes the candidates.
# ---------------------------------------------------------------------------

# shellcheck disable=SC2012 # names here are timestamps this script generates,
# so they sort lexicographically and contain nothing `ls` would mangle.
ls -1 "$RELEASES" | sort -r | tail -n "+$((KEEP_RELEASES + 1))" | while read -r old; do
  [[ $RELEASES/$old == "$(readlink -f "$CURRENT")" ]] && continue
  log "pruning release $old"
  rm -rf "${RELEASES:?}/$old"
done

docker image prune -f >/dev/null 2>&1 || true
log "deployed $SERVICE $release_id"
