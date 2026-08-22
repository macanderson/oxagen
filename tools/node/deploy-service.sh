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

readonly DEPLOY_BUCKET=oxagen-deploy-578673726240
readonly REGION=us-east-1
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

mapfile -t command < <(jq -re '.command[]' "$manifest" 2>/dev/null || true)
[[ ${#command[@]} -gt 0 ]] || fail "oxagen-run.json: 'command' must be a non-empty array"

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

previous=""
[[ -L $CURRENT ]] && previous=$(readlink -f "$CURRENT")

start_container() {
  local dir=$1
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # The migration named these `oxagen-web-<service>`. Removing that name too
  # means the first run of this script does not leave the old container
  # holding the port while the new one fails to bind it.
  docker rm -f "oxagen-web-$SERVICE" >/dev/null 2>&1 || true

  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    --network host \
    --memory "$memory" \
    --log-opt max-size=10m --log-opt max-file=3 \
    -e NODE_ENV=production \
    -e PORT="$port" \
    -e HOSTNAME=127.0.0.1 \
    -e HOST=127.0.0.1 \
    "${env_args[@]}" \
    -v "$dir:/app" \
    -w /app \
    "$image" "${command[@]}" >/dev/null
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

log "starting $SERVICE from $release_id (image $image, port $port, memory $memory)"
ln -sfn "$release" "$CURRENT"
trap - EXIT
rm -f "$tarball"

start_container "$release"

if healthy; then
  log "$SERVICE is healthy on 127.0.0.1:$port$health_path"
else
  echo "error: $SERVICE did not answer on 127.0.0.1:$port$health_path within 60s" >&2
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
