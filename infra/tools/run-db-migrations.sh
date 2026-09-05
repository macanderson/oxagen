#!/usr/bin/env bash
#
# Apply the platform's Atlas migrations to the Postgres running on the node.
#
#   tools/run-db-migrations.sh <packages/database dir>
#
# Runs on the instance rather than from a laptop because the database binds to
# loopback and is reachable only through SSM — and port-forwarding needs the
# session-manager-plugin, which cannot be installed without an interactive
# sudo. Applying from the box sidesteps that entirely.
#
# Uses the repository's `ci` Atlas environment, which takes DATABASE_URL and
# the migration directory and nothing else — no dev database, no drizzle
# export, so nothing here needs Node or the workspace installed remotely.
#
# BROKEN for the new account (916294258235) as written, and left pointed at
# the old one (578673726240) deliberately rather than half-fixed: the whole
# mechanism below assumes Postgres runs as a Docker container on the target
# instance (`docker exec oxagen-data-postgres-1`, password at
# /oxagen-data/postgres/password). The new account moved Postgres to Aurora
# PostgreSQL Serverless v2 (stacks-new/oxagen/data-services.tf) — there is no
# local Postgres container to exec into on the new node, and the password
# lives at /oxagen-app/postgres/password instead. Swapping just INSTANCE and
# BUCKET here would point a real migration run at the new node and then fail
# inside the SSM command (or worse, on an account where some other container
# happens to share that name) rather than doing anything useful. This needs a
# rewrite — apply Atlas directly against the Aurora endpoint over the VPC,
# from the node, with no docker exec — before it can run against the new
# account. Tracked as #2652.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <packages/database dir>" >&2
  exit 2
fi

DB_DIR=$(cd "$1" && pwd)
REGION=us-east-1
INSTANCE=i-023d002d6e44f8f84
BUCKET=oxagen-deploy-578673726240

[[ -d "$DB_DIR/atlas/migrations" ]] || { echo "error: no atlas/migrations under $DB_DIR" >&2; exit 1; }

TARBALL="${TMPDIR:-/tmp}/atlas-migrations.tgz"
rm -f "$TARBALL"

# COPYFILE_DISABLE stops macOS tar writing an AppleDouble `._name` sidecar for
# every file carrying extended attributes. Atlas hashes the whole migration
# directory, so those sidecars land as unknown migration files and every
# command fails with "checksum mismatch" naming a `._` file that was never
# authored.
COPYFILE_DISABLE=1 tar --exclude '._*' --exclude '.DS_Store' \
  -czf "$TARBALL" -C "$DB_DIR" atlas atlas.hcl
echo "==> packaged $(ls "$DB_DIR/atlas/migrations"/*.sql | wc -l | tr -d ' ') migrations"

aws s3 cp "$TARBALL" "s3://$BUCKET/_deploy/atlas-migrations.tgz" --only-show-errors
echo "==> uploaded"

REMOTE_FILE=$(mktemp "${TMPDIR:-/tmp}/mig-remote-XXXXXX")
PARAMS_FILE=$(mktemp "${TMPDIR:-/tmp}/mig-params-XXXXXX")
trap 'rm -f "$REMOTE_FILE" "$PARAMS_FILE"' EXIT

cat > "$REMOTE_FILE" <<'REMOTE'
set -euxo pipefail

# Atlas is a single static binary; fetch it once rather than adding a package
# repository to the instance for one tool.
if ! command -v atlas >/dev/null 2>&1; then
  curl -fsSL https://release.ariga.io/atlas/atlas-linux-arm64-latest -o /usr/local/bin/atlas
  chmod +x /usr/local/bin/atlas
fi
atlas version

mkdir -p /opt/oxagen/db
cd /opt/oxagen/db
aws s3 cp s3://oxagen-deploy-578673726240/_deploy/atlas-migrations.tgz /tmp/atlas.tgz --region us-east-1
rm -rf atlas atlas.hcl
tar -xzf /tmp/atlas.tgz -C /opt/oxagen/db

# Tracing OFF before the secret is read, and back on after it is used.
#
# `set -x` prints every expansion, so with tracing left on the line below
# echoes the database password into the SSM command output — which is stored
# in CloudTrail and returned to whoever ran the command. That happened once
# here and cost a credential rotation. Anything touching a secret runs inside
# this window.
set +x
PGPW=$(aws ssm get-parameter --region us-east-1 --name /oxagen-data/postgres/password --with-decryption --query Parameter.Value --output text)
export DATABASE_URL="postgres://oxagen:${PGPW}@localhost:5432/oxagen?sslmode=disable"
set -x

atlas migrate status --env ci || true
atlas migrate apply --env ci --allow-dirty
echo "--- applied; table count ---"
set +x
docker exec -e PGPASSWORD="$PGPW" oxagen-data-postgres-1 \
  psql -U oxagen -d oxagen -tAc \
  "select count(*) from information_schema.tables where table_schema='public'"
set -x
REMOTE

python3 - "$REMOTE_FILE" "$PARAMS_FILE" <<'PY'
import json, sys
json.dump({"commands": open(sys.argv[1]).read().splitlines()}, open(sys.argv[2], "w"))
PY

CMD=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --parameters "file://$PARAMS_FILE" \
  --query 'Command.CommandId' --output text)
echo "==> ssm command $CMD"

for _ in $(seq 1 60); do
  st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  [[ $st == InProgress || $st == Pending ]] || break
  sleep 10
done
echo "==> $st"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query StandardOutputContent --output text 2>/dev/null | tail -12
echo "--- stderr ---"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query StandardErrorContent --output text 2>/dev/null | tail -12
