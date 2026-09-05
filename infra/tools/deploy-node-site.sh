#!/usr/bin/env bash
#
# Ship a Next.js standalone build to the shared node and serve it behind Caddy.
#
#   tools/deploy-node-site.sh <app-dir> <site-name> <hostname> <port>
#
# e.g. tools/deploy-node-site.sh …/website stella stella.oxagen.sh 3001
#
# Why this exists rather than Lambda: CloudFront in front of a Lambda Function
# URL returned 403 for every request in this account, including with the URL's
# own auth disabled — a state that should serve. Rather than keep debugging a
# managed front door during an outage, the dynamic sites run as ordinary Node
# processes on the instance that already hosts the databases, which is also
# where the platform's own apps have to run to reach Postgres over loopback.
#
# The transfer goes through S3 rather than SSM. An SSM command payload is
# capped well below the size of a build, and S3 is already in the path.

set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <app-dir> <site-name> <hostname> <port>" >&2
  exit 2
fi

APP_DIR=$(cd "$1" && pwd)
NAME=$2
HOSTNAME_=$3
PORT=$4

REGION=us-east-1
INSTANCE=i-023d002d6e44f8f84
BUCKET=oxagen-deploy-578673726240
STANDALONE="$APP_DIR/.next/standalone"

# Where `server.js` lands depends on the workspace. A standalone app sits at
# the root of the output; inside a monorepo Next preserves the path from the
# workspace root, so it is `apps/<name>/server.js` with a single shared
# `node_modules` beside it. Both must ship whole — copying only the inner
# directory leaves the server without its dependencies.
SERVER_REL=$(cd "$STANDALONE" 2>/dev/null && find . -name server.js -maxdepth 4 -not -path '*/node_modules/*' | head -1 | sed 's|^\./||')

if [[ -z ${SERVER_REL:-} ]]; then
  echo "error: no standalone server.js under $STANDALONE" >&2
  echo "       build with STANDALONE=1 and 'output: standalone' first" >&2
  exit 1
fi

APP_REL=$(dirname "$SERVER_REL")
echo "==> standalone entrypoint: $SERVER_REL"

# The standalone output deliberately excludes static assets and anything under
# public/ — Next expects those to be served alongside it, and without them the
# page renders with no CSS and every image broken. They go next to the server,
# which in a monorepo is the nested directory rather than the output root.
mkdir -p "$STANDALONE/$APP_REL/.next"
[[ -d "$APP_DIR/.next/static" ]] && cp -R "$APP_DIR/.next/static" "$STANDALONE/$APP_REL/.next/static"
[[ -d "$APP_DIR/public" ]] && cp -R "$APP_DIR/public" "$STANDALONE/$APP_REL/public"

TARBALL="/tmp/$NAME-standalone.tgz"
rm -f "$TARBALL"
tar -czf "$TARBALL" -C "$STANDALONE" .
SIZE=$(du -h "$TARBALL" | cut -f1)
echo "==> packaged $NAME ($SIZE)"

aws s3 cp "$TARBALL" "s3://$BUCKET/_deploy/$NAME-standalone.tgz" --only-show-errors
echo "==> uploaded to s3://$BUCKET/_deploy/$NAME-standalone.tgz"

# Run the unpack and restart on the instance. `set -e` inside so a failed step
# surfaces as a failed SSM command rather than a green run with a dead site.
read -r -d '' REMOTE <<REMOTE_EOF || true
set -euxo pipefail
mkdir -p /opt/oxagen/web/$NAME
cd /opt/oxagen/web/$NAME
aws s3 cp s3://$BUCKET/_deploy/$NAME-standalone.tgz /tmp/$NAME.tgz --region $REGION
rm -rf ./*
tar -xzf /tmp/$NAME.tgz -C /opt/oxagen/web/$NAME
docker rm -f oxagen-web-$NAME 2>/dev/null || true
docker run -d --name oxagen-web-$NAME --restart unless-stopped \
  -p 127.0.0.1:$PORT:3000 \
  -e NODE_ENV=production -e PORT=3000 -e HOSTNAME=0.0.0.0 \
  -v /opt/oxagen/web/$NAME:/app -w /app \
  node:22-alpine node $SERVER_REL
sleep 6
docker ps --filter name=oxagen-web-$NAME --format '{{.Names}} {{.Status}}'
curl -fsS -o /dev/null -w 'local health: %{http_code}\n' http://127.0.0.1:$PORT/ || echo "local health: FAILED"
REMOTE_EOF

# The script goes to SSM as a JSON file, not as an inline shell-interpolated
# argument. Interpolating it collapsed every newline into a literal "n", so the
# remote shell received one run-on line ("truendocker: command not found") and
# reported Success for a command that had executed nothing.
# No suffix after the X's: BSD mktemp (macOS) requires the template to *end*
# in X's and fails outright otherwise, which reads as "File exists".
REMOTE_FILE=$(mktemp "${TMPDIR:-/tmp}/oxagen-remote-XXXXXX")
PARAMS_FILE=$(mktemp "${TMPDIR:-/tmp}/oxagen-params-XXXXXX")
trap 'rm -f "$REMOTE_FILE" "$PARAMS_FILE"' EXIT
printf '%s\n' "$REMOTE" > "$REMOTE_FILE"

python3 - "$REMOTE_FILE" "$PARAMS_FILE" <<'PY'
import json, sys
script = open(sys.argv[1]).read()
# AWS-RunShellScript takes a list of lines; splitting here keeps each one
# intact instead of relying on the shell to preserve newlines.
json.dump({"commands": script.splitlines()}, open(sys.argv[2], "w"))
PY

CMD=$(aws ssm send-command \
  --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters "file://$PARAMS_FILE" \
  --query 'Command.CommandId' --output text)

echo "==> ssm command $CMD"
for _ in $(seq 1 40); do
  st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  [[ $st == InProgress || $st == Pending ]] || break
  sleep 10
done
echo "==> $st"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" \
  --query StandardOutputContent --output text 2>/dev/null | tail -6
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" \
  --query StandardErrorContent --output text 2>/dev/null | tail -6
