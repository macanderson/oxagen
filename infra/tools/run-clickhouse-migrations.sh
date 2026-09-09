#!/usr/bin/env bash
#
# Apply the platform's ClickHouse schema and migrations to the production
# ClickHouse on the app node.
#
#   infra/tools/run-clickhouse-migrations.sh <packages/telemetry dir> [--apply]
#
# Without --apply this prints what the database holds and which migration
# files are not yet recorded in its `_migrations` ledger, and changes nothing.
# With --apply it runs the repository's own migration runner
# (packages/telemetry/src/migrate.ts) against the database.
#
# Why this exists. Production ClickHouse listens on the node's loopback and
# nowhere else, so nothing outside the box can reach it. The runner is a
# TypeScript module that needs the workspace installed, and the node has no
# Node toolchain. On 2026-09-09 the production database was found with no
# tables at all: it had been created empty at the account cutover, no path
# existed to apply the schema to it, and every metering insert since had
# been dropped by the telemetry circuit breaker. This is that path.
#
# How. The runner is bundled here with esbuild into one ESM file, packed with
# schema.sql and migrations/ beside it (the runner reads both relative to its
# own location), uploaded to the deploy bucket, and run on the node inside the
# node:22 container image the services already use, on the host network so
# 127.0.0.1 is the node's own ClickHouse. The credentials are read on the
# node from Parameter Store and handed to the container through its
# environment; they never reach this machine and are never printed.
#
# The same shape as run-db-migrations.sh beside it, which does this for
# Aurora with Atlas.

# render_remote_clickhouse_migration BUCKET IMAGE APPLY
#
# APPLY is "1" to apply, anything else for a status-only dry run.
# Writes the rendered script to stdout. Fails if any placeholder survives.
render_remote_clickhouse_migration() {
  if [[ $# -ne 3 ]]; then
    echo "render_remote_clickhouse_migration: expected 3 arguments, got $#" >&2
    return 2
  fi

  local bucket=$1 image=$2 apply=$3
  local arg name
  local -a names=(bucket image apply)
  local i=0
  for arg in "$bucket" "$image" "$apply"; do
    name=${names[$i]}
    i=$((i + 1))
    if [[ -z $arg ]]; then
      echo "render_remote_clickhouse_migration: $name is empty" >&2
      return 2
    fi
  done

  local rendered
  rendered=$(
    cat <<'REMOTE'
set -euo pipefail

# Tracing is never turned on in this script. Every expansion a trace prints
# would land in the SSM command output, which CloudTrail keeps, and the lines
# below hold the database password.

mkdir -p /opt/oxagen/clickhouse-migrate
cd /opt/oxagen/clickhouse-migrate
aws s3 cp "s3://__BUCKET__/_deploy/clickhouse-migrations.tgz" /tmp/clickhouse-migrations.tgz \
  --region us-east-1 --only-show-errors
rm -rf migrate.mjs schema.sql migrations
tar -xzf /tmp/clickhouse-migrations.tgz -C /opt/oxagen/clickhouse-migrate
rm -f /tmp/clickhouse-migrations.tgz
echo "==> $(find migrations -name '*.sql' | wc -l | tr -d ' ') migration files staged"

param() {
  aws ssm get-parameter --region us-east-1 --name "/oxagen/production/$1" \
    --with-decryption --query Parameter.Value --output text
}
CLICKHOUSE_URL=$(param CLICKHOUSE_URL)
CLICKHOUSE_USERNAME=$(param CLICKHOUSE_USERNAME)
CLICKHOUSE_PASSWORD=$(param CLICKHOUSE_PASSWORD)
CLICKHOUSE_DATABASE=$(param CLICKHOUSE_DATABASE)
export CLICKHOUSE_URL CLICKHOUSE_USERNAME CLICKHOUSE_PASSWORD CLICKHOUSE_DATABASE

# The URL the platform is configured with names no port; the client library
# defaults to 8123, and so does this.
CH_HTTP="$CLICKHOUSE_URL"
if [[ $CH_HTTP != *:[0-9]* ]]; then
  CH_HTTP="$CH_HTTP:8123"
fi

# Status, before and after: the tables the database holds and the files the
# ledger has not recorded. `_migrations` may not exist yet on a fresh
# database, which is exactly the state this script was written for.
status() {
  echo "--- tables in $CLICKHOUSE_DATABASE"
  curl -sS --max-time 30 "$CH_HTTP/?database=$CLICKHOUSE_DATABASE" \
    --user "$CLICKHOUSE_USERNAME:$CLICKHOUSE_PASSWORD" \
    --data-binary "SELECT name, total_rows FROM system.tables WHERE database = currentDatabase() ORDER BY name FORMAT TSV" \
    | sed 's/^/    /'
  echo "--- migration files not in the ledger"
  local applied
  applied=$(curl -sS --max-time 30 "$CH_HTTP/?database=$CLICKHOUSE_DATABASE" \
    --user "$CLICKHOUSE_USERNAME:$CLICKHOUSE_PASSWORD" \
    --data-binary "SELECT DISTINCT filename FROM _migrations ORDER BY filename FORMAT TSV" 2>/dev/null || true)
  local pending=0 f
  for f in $(find migrations -name '*.sql' -printf '%f\n' | sort); do
    if ! printf '%s\n' "$applied" | grep -qxF "$f"; then
      echo "    $f"
      pending=$((pending + 1))
    fi
  done
  echo "    ($pending pending)"
}

status

__TAIL__
REMOTE
  )

  # The apply is rendered in or left out, rather than guarded by a runtime
  # `if`, so a dry run cannot apply: the text that would apply is not in the
  # script that reaches the node.
  local tail
  if [[ $apply == "1" ]]; then
    tail='echo "==> applying"
docker run --rm --network host \
  -e CLICKHOUSE_URL -e CLICKHOUSE_USERNAME -e CLICKHOUSE_PASSWORD -e CLICKHOUSE_DATABASE \
  -v /opt/oxagen/clickhouse-migrate:/work:ro -w /work \
  __IMAGE__ node migrate.mjs
echo "--- applied; status after apply (expect 0 pending) ---"
status'
  else
    tail='echo "--- dry run: nothing was applied. Re-run with --apply. ---"'
  fi
  rendered=${rendered//__TAIL__/$tail}
  rendered=${rendered//__BUCKET__/$bucket}
  rendered=${rendered//__IMAGE__/$image}

  if [[ $rendered == *__* ]]; then
    echo "render_remote_clickhouse_migration: unsubstituted placeholder in rendered script" >&2
    printf '%s\n' "$rendered" | grep -n '__' >&2
    return 1
  fi

  printf '%s\n' "$rendered"
}

# ---------------------------------------------------------------------------
# Everything above is definitions; everything below runs.
#
# infra/tools/tests/render-remote-clickhouse-migration.test.sh sources this
# file to render the remote script and read it. Returning here is what makes
# that safe: a source gets the function and none of the AWS calls.
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0
fi

set -euo pipefail

APPLY=0
TELEMETRY_DIR_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    -h|--help)
      echo "usage: $0 <packages/telemetry dir> [--apply]" >&2
      exit 0
      ;;
    -*)
      echo "error: unknown option $1" >&2
      echo "usage: $0 <packages/telemetry dir> [--apply]" >&2
      exit 2
      ;;
    *)
      if [[ -n $TELEMETRY_DIR_ARG ]]; then
        echo "error: unexpected argument $1" >&2
        exit 2
      fi
      TELEMETRY_DIR_ARG=$1
      shift
      ;;
  esac
done

if [[ -z $TELEMETRY_DIR_ARG ]]; then
  echo "usage: $0 <packages/telemetry dir> [--apply]" >&2
  exit 2
fi

TELEMETRY_DIR=$(cd "$TELEMETRY_DIR_ARG" && pwd)
REGION=us-east-1

# Resolved by tag, not pinned to an id: the node is replaced whenever its user
# data changes, and every pinned id then points at a terminated box.
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
BUCKET=${BUCKET:-oxagen-deploy-916294258235}
# The image the services run in (tools/scripts/package-for-node.sh), so it is
# already on the node and nothing is pulled onto a disk this repository has
# had to grow once.
IMAGE=${IMAGE:-node:22-alpine}

[[ -f "$TELEMETRY_DIR/src/migrate.ts" ]] || { echo "error: no src/migrate.ts under $TELEMETRY_DIR" >&2; exit 1; }
[[ -f "$TELEMETRY_DIR/src/schema.sql" ]] || { echo "error: no src/schema.sql under $TELEMETRY_DIR" >&2; exit 1; }
[[ -d "$TELEMETRY_DIR/src/migrations" ]] || { echo "error: no src/migrations under $TELEMETRY_DIR" >&2; exit 1; }

ONLINE=$(aws ssm describe-instance-information --region "$REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE" \
  --query 'length(InstanceInformationList)' --output text 2>/dev/null || echo 0)
if [[ $ONLINE != "1" ]]; then
  echo "error: instance $INSTANCE is not registered with SSM in $REGION." >&2
  echo "error: nothing can run on it, so this would poll and then time out." >&2
  exit 1
fi

# esbuild comes with tsx, which the telemetry package declares, so the
# workspace has to be installed for this to run — the same requirement
# `pnpm --filter @oxagen/telemetry migrate` has.
ESBUILD=$(cd "$TELEMETRY_DIR" && node -p "
  const path = require('path');
  const tsx = path.dirname(require.resolve('tsx/package.json'));
  path.join(path.dirname(require.resolve('esbuild/package.json', { paths: [tsx] })), 'bin', 'esbuild');
")
[[ -x $ESBUILD ]] || { echo "error: esbuild not found via tsx under $TELEMETRY_DIR — is the workspace installed?" >&2; exit 1; }

STAGE=$(mktemp -d "${TMPDIR:-/tmp}/clickhouse-migrate-XXXXXX")
REMOTE_FILE=$(mktemp "${TMPDIR:-/tmp}/chmig-remote-XXXXXX")
PARAMS_FILE=$(mktemp "${TMPDIR:-/tmp}/chmig-params-XXXXXX")
trap 'rm -rf "$STAGE" "$REMOTE_FILE" "$PARAMS_FILE"' EXIT

# One ESM file. The runner reads schema.sql and migrations/ beside its own
# import.meta.url, which the bundle keeps, so both are staged next to it. The
# banner gives the CommonJS dependencies inside the bundle the `require`,
# `__filename` and `__dirname` they expect and an ESM file does not have.
echo "==> bundling $TELEMETRY_DIR/src/migrate.ts"
"$ESBUILD" "$TELEMETRY_DIR/src/migrate.ts" \
  --bundle --platform=node --format=esm --target=node22 \
  --log-level=warning \
  --banner:js='import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirname_of } from "node:path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirname_of(__filename);' \
  --outfile="$STAGE/migrate.mjs"
cp "$TELEMETRY_DIR/src/schema.sql" "$STAGE/schema.sql"
mkdir -p "$STAGE/migrations"
cp "$TELEMETRY_DIR/src/migrations/"*.sql "$STAGE/migrations/"

TARBALL="$STAGE/clickhouse-migrations.tgz"
# COPYFILE_DISABLE and --no-xattrs stop macOS tar writing `._name` sidecars
# and extended-attribute headers; the runner applies every *.sql it finds,
# a sidecar is not SQL, and the node's tar warns on every header it does not
# know.
COPYFILE_DISABLE=1 tar --no-xattrs --exclude '._*' --exclude '.DS_Store' \
  -czf "$TARBALL" -C "$STAGE" migrate.mjs schema.sql migrations
echo "==> packaged $(du -h "$TARBALL" | cut -f1) — bundle $(du -h "$STAGE/migrate.mjs" | cut -f1), $(find "$STAGE/migrations" -name '*.sql' | wc -l | tr -d ' ') migrations"

aws s3 cp "$TARBALL" "s3://$BUCKET/_deploy/clickhouse-migrations.tgz" --region "$REGION" --only-show-errors
echo "==> uploaded to s3://$BUCKET/_deploy/"

render_remote_clickhouse_migration "$BUCKET" "$IMAGE" "$APPLY" > "$REMOTE_FILE"

if [[ $APPLY == "1" ]]; then
  echo "==> APPLYING migrations on $INSTANCE"
else
  echo "==> dry run (status only) on $INSTANCE; pass --apply to apply"
fi

python3 - "$REMOTE_FILE" "$PARAMS_FILE" <<'PY'
import json, sys
json.dump({"commands": open(sys.argv[1]).read().splitlines()}, open(sys.argv[2], "w"))
PY

CMD=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --parameters "file://$PARAMS_FILE" \
  --timeout-seconds 900 \
  --query 'Command.CommandId' --output text)
echo "==> ssm command $CMD"

st=Pending
for _ in $(seq 1 90); do
  st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  [[ $st == InProgress || $st == Pending || $st == Delayed ]] || break
  sleep 10
done
echo "==> $st"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query StandardOutputContent --output text 2>/dev/null | tail -80
echo "--- stderr ---"
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query StandardErrorContent --output text 2>/dev/null | tail -40

# The status is the result, so it is the exit code.
if [[ $st != "Success" ]]; then
  echo "==> FAILED: ssm command $CMD finished as $st" >&2
  exit 1
fi
