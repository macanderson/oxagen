#!/usr/bin/env bash
#
# Ship the internal docs site to the app node, password-protected, at
# https://internal.oxagen.sh.
#
#   env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
#     infra/tools/deploy-internal-docs.sh <site-out-dir>
#
# <site-out-dir> is a Next static export (`output: "export"`), e.g. `site/out`
# from macanderson/tmp-oxagen-mockups. The `env -u` matters on a laptop that
# still exports the old account's static keys: this script refuses to run
# against any account but 916294258235.
#
# The site ships as an ordinary service artifact, `internal-docs-standalone.tgz`,
# holding the export, its own Caddyfile (tools/internal-docs/Caddyfile) and an
# `oxagen-run.json`. The node installs it with `oxagen-deploy-service`, the same
# SSM document CI uses, so the release swap, rollback, disk floor and restore on
# node replacement are deploy-service.sh's and not reimplemented here.
#
# Before the first deploy (once, see tools/node/README.md "The internal docs
# site"): the certificate and DNS record are applied, the route in
# tools/caddy/Caddyfile.alb is installed with tools/install-node-scripts.sh, and
# the two password parameters exist.
#
# After the deploy the script checks from outside: no credentials must get 401,
# the password must get 200, and app.oxagen.sh/login and api.oxagen.sh/health
# must still answer 200, because the site's Caddy shares the host network with
# the front door's.

readonly INTERNAL_DOCS_SERVICE=internal-docs
readonly INTERNAL_DOCS_PORT=3003
readonly INTERNAL_DOCS_HOST=internal.oxagen.sh
readonly INTERNAL_DOCS_CONFIG_PREFIX=/oxagen/production/internal-docs
# Outside /oxagen/production on purpose. app, api and mcp load that prefix
# recursively into their environment; the plaintext password is for people and
# no service needs it. Only the bcrypt hash sits under the site's config_prefix.
readonly INTERNAL_DOCS_PASSWORD_PARAM=/oxagen/internal/INTERNAL_DOCS_PASSWORD
readonly INTERNAL_DOCS_USER=oxagen

# Stage the artifact's contents into <out-dir>: site/, Caddyfile, oxagen-run.json.
stage_internal_docs() {
  local site_dir=$1 out=$2 caddyfile=$3

  if [[ ! -d $site_dir ]]; then
    echo "error: '$site_dir' is not a directory" >&2
    return 1
  fi
  if [[ ! -f $site_dir/index.html ]]; then
    echo "error: '$site_dir' has no index.html; build the site with output: \"export\" first" >&2
    return 1
  fi
  # The same floor as deploy-static.sh: an export of one file is a failed
  # build, and publishing it replaces a working site with it.
  local file_count
  file_count=$(command find "$site_dir" -type f | wc -l | tr -d ' ')
  if [[ $file_count -lt 2 ]]; then
    echo "error: '$site_dir' holds $file_count files; refusing to publish what looks like a failed build" >&2
    return 1
  fi
  if [[ ! -f $caddyfile ]]; then
    echo "error: no Caddyfile at '$caddyfile'" >&2
    return 1
  fi

  mkdir -p "$out/site"
  cp -R "$site_dir"/. "$out/site/"
  cp "$caddyfile" "$out/Caddyfile"

  # deploy-service.sh passes PORT; the Caddyfile listens on {$PORT}.
  jq -n \
    --argjson port "$INTERNAL_DOCS_PORT" \
    --arg prefix "$INTERNAL_DOCS_CONFIG_PREFIX" \
    '{
       port: $port,
       image: "caddy:2",
       command: ["caddy", "run", "--config", "/app/Caddyfile", "--adapter", "caddyfile"],
       memory: "128m",
       health_path: "/healthz",
       config_prefix: $prefix
     }' > "$out/oxagen-run.json"
}

# Pack <stage-dir> into the gzipped tarball <tarball>.
#
# On a Mac, tar copies each file's extended attributes into the archive:
# macOS stamps com.apple.provenance on nearly every file, and bsdtar writes it
# as a LIBARCHIVE.xattr pax header, plus an AppleDouble ._ file wherever
# copyfile has metadata to save. GNU tar on the node does not know that
# keyword and prints "Ignoring unknown extended header keyword" once per file,
# which buries the deploy log. COPYFILE_DISABLE=1 stops the ._ files and
# --no-xattrs stops the headers. bsdtar and GNU tar (1.27 and later) both take
# --no-xattrs, but a tar that does not refuses the whole command, so the flag
# is passed only when this tar accepts it.
pack_internal_docs() {
  local stage=$1 tarball=$2
  local -a flags=()
  if tar_accepts_no_xattrs "$stage"; then
    flags+=(--no-xattrs)
  fi
  COPYFILE_DISABLE=1 tar ${flags[@]+"${flags[@]}"} -czf "$tarball" -C "$stage" .
}

# Whether tar accepts --no-xattrs, by archiving <dir> to /dev/null with it.
# `tar --help` is no guide: bsdtar's short help leaves out flags it supports.
tar_accepts_no_xattrs() {
  COPYFILE_DISABLE=1 tar --no-xattrs -cf /dev/null -C "$1" . >/dev/null 2>&1
}

# HTTP status of <url>, with no credentials.
http_status() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || echo 000
}

# HTTP status of <url> with the site's basic-auth password. The credential goes
# to curl on stdin as a config file, not in argv, where any process could read
# it from /proc while curl runs.
http_status_with_password() {
  local url=$1 password=$2
  printf 'user = "%s:%s"\n' "$INTERNAL_DOCS_USER" "$password" \
    | curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -K - "$url" 2>/dev/null \
    || echo 000
}

# Judge the four post-deploy statuses. Prints one line per check; returns 1 if
# any is wrong.
internal_docs_verdict() {
  local anonymous=$1 authenticated=$2 app=$3 api=$4 bad=0
  check() {
    if [[ $2 == "$3" ]]; then
      printf 'ok    %-44s %s\n' "$1" "$2"
    else
      printf 'FAIL  %-44s %s (want %s)\n' "$1" "$2" "$3"
      bad=1
    fi
  }
  check "https://$INTERNAL_DOCS_HOST/ without credentials" "$anonymous" 401
  check "https://$INTERNAL_DOCS_HOST/ with the password" "$authenticated" 200
  check "https://app.oxagen.sh/login" "$app" 200
  check "https://api.oxagen.sh/health" "$api" 200
  unset -f check
  return "$bad"
}

if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0
fi

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <site-out-dir>" >&2
  exit 2
fi

readonly REGION=us-east-1
readonly ACCOUNT=916294258235
readonly BUCKET=oxagen-deploy-$ACCOUNT
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if ! account=$(aws sts get-caller-identity --query Account --output text 2>&1); then
  echo "error: AWS credentials are not usable ($account). Run 'aws login'." >&2
  exit 1
fi
if [[ $account != "$ACCOUNT" ]]; then
  echo "error: credentials are for account $account, not $ACCOUNT. Static AWS_* keys in the environment point at the old account; run with env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN." >&2
  exit 1
fi

# Resolved by tag, not pinned to an id: the node is replaced whenever its user
# data changes.
if [[ -z "${INSTANCE:-}" ]]; then
  INSTANCE=$(aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=tag:Name,Values=${NODE_NAME:-oxagen-app}" \
              "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].InstanceId' --output text)
  if [[ $(printf '%s' "$INSTANCE" | wc -w) -ne 1 ]]; then
    echo "expected exactly one running instance tagged Name=${NODE_NAME:-oxagen-app}, got: $INSTANCE" >&2
    exit 1
  fi
fi

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/oxagen-internal-docs-XXXXXX")
TARBALL=$(mktemp "${TMPDIR:-/tmp}/oxagen-internal-docs-tgz-XXXXXX")
trap 'rm -rf "$STAGE" "$TARBALL"' EXIT

stage_internal_docs "$1" "$STAGE" "$HERE/internal-docs/Caddyfile"
pack_internal_docs "$STAGE" "$TARBALL"
echo "==> packaged $INTERNAL_DOCS_SERVICE ($(du -h "$TARBALL" | cut -f1), $(command find "$STAGE/site" -type f | wc -l | tr -d ' ') files)"

aws s3 cp "$TARBALL" "s3://$BUCKET/_deploy/$INTERNAL_DOCS_SERVICE-standalone.tgz" \
  --region "$REGION" --only-show-errors
echo "==> uploaded to s3://$BUCKET/_deploy/$INTERNAL_DOCS_SERVICE-standalone.tgz"

CMD=$(aws ssm send-command \
  --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name oxagen-deploy-service \
  --parameters "service=$INTERNAL_DOCS_SERVICE" \
  --query 'Command.CommandId' --output text)
echo "==> ssm command $CMD on $INSTANCE"

# The document allows 900 s; poll a little past it.
st=Pending
for _ in $(seq 1 95); do
  st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" \
       --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  [[ $st == InProgress || $st == Pending || $st == Delayed ]] || break
  sleep 10
done

echo "==> $st"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" \
  --query StandardOutputContent --output text 2>/dev/null | tail -20
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" \
  --query StandardErrorContent --output text 2>/dev/null | tail -20
[[ $st == Success ]] || exit 1

echo "==> checking from outside"
anonymous=$(http_status "https://$INTERNAL_DOCS_HOST/")
password=$(aws ssm get-parameter --region "$REGION" --name "$INTERNAL_DOCS_PASSWORD_PARAM" \
  --with-decryption --query Parameter.Value --output text)
authenticated=$(http_status_with_password "https://$INTERNAL_DOCS_HOST/" "$password")
unset password
app=$(http_status "https://app.oxagen.sh/login")
api=$(http_status "https://api.oxagen.sh/health")

internal_docs_verdict "$anonymous" "$authenticated" "$app" "$api"
