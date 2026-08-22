#!/usr/bin/env bash
#
# Put the node-side deploy scripts on the node.
#
#   tools/install-node-scripts.sh
#
# `tools/node/` is the source of truth; the copies under /opt/oxagen/bin are
# installed from it. Run this after changing anything in that directory —
# there is deliberately no mechanism that syncs them on its own, because a
# script that rewrites itself on the box during a deploy is a worse failure
# than a stale one.
#
# The transfer goes through S3 rather than an inline SSM payload for the same
# reason the artifact does: an SSM command's parameters are capped, and the
# cap is not generous. Uploading first also means the install is idempotent —
# re-running it re-copies the same objects.

set -euo pipefail

REGION=us-east-1
INSTANCE=i-023d002d6e44f8f84
BUCKET=oxagen-deploy-578673726240

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

echo "==> uploading tools/node -> s3://$BUCKET/_bin/"
aws s3 sync "$HERE/node" "s3://$BUCKET/_bin/" \
  --region "$REGION" --exclude '*.md' --delete --only-show-errors

read -r -d '' REMOTE <<'REMOTE_EOF' || true
set -euxo pipefail
mkdir -p /opt/oxagen/bin /opt/oxagen/services
aws s3 sync s3://oxagen-deploy-578673726240/_bin/ /opt/oxagen/bin/ --region us-east-1 --delete
chmod 0755 /opt/oxagen/bin/*.sh
# Fail the install rather than the first deploy if a dependency is missing.
for tool in jq python3 curl docker aws; do
  command -v "$tool" >/dev/null || { echo "missing dependency: $tool"; exit 1; }
done
bash -n /opt/oxagen/bin/deploy-service.sh
ls -l /opt/oxagen/bin
REMOTE_EOF

# The script goes to SSM as a JSON file, not as an inline shell-interpolated
# argument. Interpolating it collapsed every newline into a literal "n" during
# the migration, so the remote shell received one run-on line and reported
# Success for a command that had executed nothing.
REMOTE_FILE=$(mktemp "${TMPDIR:-/tmp}/oxagen-remote-XXXXXX")
PARAMS_FILE=$(mktemp "${TMPDIR:-/tmp}/oxagen-params-XXXXXX")
trap 'rm -f "$REMOTE_FILE" "$PARAMS_FILE"' EXIT
printf '%s\n' "$REMOTE" > "$REMOTE_FILE"

python3 - "$REMOTE_FILE" "$PARAMS_FILE" <<'PY'
import json, sys
script = open(sys.argv[1]).read()
json.dump({"commands": script.splitlines()}, open(sys.argv[2], "w"))
PY

CMD=$(aws ssm send-command \
  --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters "file://$PARAMS_FILE" \
  --query 'Command.CommandId' --output text)

echo "==> ssm command $CMD"
for _ in $(seq 1 30); do
  st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" \
       --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  [[ $st == InProgress || $st == Pending ]] || break
  sleep 5
done

echo "==> $st"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" \
  --query StandardOutputContent --output text 2>/dev/null | tail -20
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" \
  --query StandardErrorContent --output text 2>/dev/null | tail -20

[[ $st == Success ]] || exit 1
