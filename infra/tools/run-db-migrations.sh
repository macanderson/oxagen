#!/usr/bin/env bash
#
# Apply the platform's Atlas migrations to the production Aurora cluster.
#
#   infra/tools/run-db-migrations.sh <packages/database dir> [--apply]
#
# Without --apply this prints the pending list and changes nothing. Read that
# list before applying: an empty revision table shows the entire history as
# pending, and applying from there tries to re-create objects that already
# exist.
#
# Runs the migration from the app node rather than from a laptop or a CI
# runner because Aurora's security group admits 5432 from the app node's
# security group and nothing else (stacks-new/oxagen/data-services.tf's
# aws_security_group.aurora). .github/workflows/db-migrate.yml is the same
# migration from a hosted runner, which is outside the VPC — it now says so
# and stops rather than hanging. This script is the path that works.
#
# Uses the repository's `ci` Atlas environment, which takes DATABASE_URL and
# the migration directory and nothing else — no dev database, no drizzle
# export, so nothing here needs Node or the workspace installed remotely.
#
# The cluster endpoint is resolved HERE and substituted into the remote
# script, not looked up on the node: the node's role grants ssm:GetParameter
# on its own /oxagen-app/* prefix and no RDS permissions at all
# (infra/modules/app-node/main.tf). The password is read the other way round —
# on the node, inside a tracing-off window — so it never reaches this machine.

# render_remote_migration BUCKET HOST PORT DATABASE USER APPLY ALLOW_DIRTY
#
# APPLY is "1" to apply, anything else for a status-only dry run.
# ALLOW_DIRTY is "1" to pass --allow-dirty to `atlas migrate apply`.
# Writes the rendered script to stdout. Fails if any placeholder survives.
render_remote_migration() {
  if [[ $# -ne 7 ]]; then
    echo "render_remote_migration: expected 7 arguments, got $#" >&2
    return 2
  fi

  local bucket=$1 host=$2 port=$3 database=$4 user=$5 apply=$6 allow_dirty=$7
  local arg name

  # An empty value renders a script that fails somewhere further in, on a
  # message about the wrong thing — `s3://` with no bucket reads as a broken
  # URL rather than as a missing argument.
  local -a names=(bucket host port database user apply allow_dirty)
  local i=0
  for arg in "$bucket" "$host" "$port" "$database" "$user" "$apply" "$allow_dirty"; do
    name=${names[$i]}
    i=$((i + 1))
    if [[ -z $arg ]]; then
      echo "render_remote_migration: $name is empty" >&2
      return 2
    fi
  done

  local apply_flag="0"
  [[ $apply == "1" ]] && apply_flag="1"

  local dirty_flag=""
  [[ $allow_dirty == "1" ]] && dirty_flag="--allow-dirty"

  local rendered
  rendered=$(
    cat <<'REMOTE'
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
aws s3 cp "s3://__BUCKET__/_deploy/atlas-migrations.tgz" /tmp/atlas.tgz --region us-east-1
rm -rf atlas atlas.hcl
tar -xzf /tmp/atlas.tgz -C /opt/oxagen/db

# Tracing OFF before the secret is read, and back on after it is used.
#
# `set -x` prints every expansion, so with tracing left on the line below
# echoes the database password into the SSM command output — which is stored
# in CloudTrail and returned to whoever ran the command. That happened once
# here and cost a credential rotation. Anything touching a secret runs inside
# this window, including the check below, which tests the password without
# printing it.
set +x
PGPW=$(aws ssm get-parameter --region us-east-1 --name /oxagen-app/postgres/password --with-decryption --query Parameter.Value --output text)

# The password goes into a URL, so a character with meaning in a URL would be
# read as structure rather than as password. Terraform generates this one with
# `special = false` (stacks-new/oxagen/data-services.tf's random_password
# "aurora"), so it is alphanumeric by construction — this catches a hand
# rotation that broke that assumption, and says so, instead of failing later
# on a connection error naming the wrong host.
if ! printf '%s' "$PGPW" | grep -qE '^[A-Za-z0-9]+$'; then
  set -x
  echo "error: the password at /oxagen-app/postgres/password is not alphanumeric" >&2
  echo "error: it needs percent-encoding before it can go in DATABASE_URL" >&2
  exit 1
fi

# sslmode=require, not disable: Aurora is reached over the VPC rather than
# over loopback, so the session is worth encrypting. `require` asks for TLS
# without verifying the CA, which is what lets this run with no RDS CA bundle
# staged on the node.
#
# The `options` query parameter, carrying `app.rls_bypass` turned on and
# percent-encoded, is what makes the directory applicable at all against a
# managed cluster (#1368). Every Postgres this
# pipeline has ever applied to before Aurora ran the migrations as a real
# superuser, and a superuser bypasses RLS for free. Aurora has none: the master
# user gets `rds_superuser`, which is not that bit. So a rebuild from empty
# stops at file 14 of the directory:
#
#   20260614000000_seed_official_mcp_registry.sql inserts the global registry
#   row with org_id = NULL. mcp.registries has FORCE ROW LEVEL SECURITY, so the
#   table's own owner is subject to tenant_isolation, and the policy in force at
#   that point in history (20260612210000) has an `org_id IS NULL` arm in its
#   USING and none in its WITH CHECK. NULL = <uuid> is NULL, the check fails:
#
#     pq: new row violates row-level security policy for table "registries" (42501)
#
# A forward migration cannot fix that, which is the whole reason the bypass
# lives here rather than in the schema. Atlas replays in version order, so the
# seed runs against the policy as it stood ~90 files ago; a policy corrected
# today is corrected long after the statement that needs it. The historical file
# cannot be edited either — its hash is in atlas.sum and in every deployed
# atlas_schema_revisions. Only the connection can carry the fix.
#
# Granting it costs no privilege. `app.rls_bypass` is a GUC the policies read,
# not a Postgres permission, so the role stays NOSUPERUSER NOBYPASSRLS and the
# rds-compatibility job still catches genuinely superuser-only statements. It is
# the same GUC the application's own withSystemDb path sets for system writes,
# and a role applying schema changes and seeds is the system.
#
# tools/scripts/rds-sim-check.sh connects exactly this way and applies the whole
# directory as a NOSUPERUSER NOBYPASSRLS role on every PR, which is the standing
# evidence that Atlas honours the parameter and that the directory needs it.
export DATABASE_URL="postgres://__PGUSER__:${PGPW}@__PGHOST__:__PGPORT__/__PGDB__?sslmode=require&options=-c%20app.rls_bypass%3Don"
set -x

# Not `|| true`. A status that cannot run is a database this script cannot
# reach, and continuing to the apply from there only moves the same failure
# somewhere harder to read.
atlas migrate status --env ci

__TAIL__
REMOTE
  )

  # The apply is rendered in or left out, rather than guarded by a runtime
  # `if`. A dry run then cannot apply because the text that would apply is not
  # in the script that reaches the node — a stronger claim than a branch that
  # was not taken, and one a reader of the SSM command output can check.
  local tail
  if [[ $apply_flag == "1" ]]; then
    local apply_line="atlas migrate apply --env ci"
    [[ -n $dirty_flag ]] && apply_line="$apply_line $dirty_flag"
    tail="$apply_line
echo \"--- applied; status after apply (expect no pending) ---\"
atlas migrate status --env ci"
  else
    tail='echo "--- dry run: nothing was applied. Re-run with --apply. ---"'
  fi
  rendered=${rendered//__TAIL__/$tail}

  rendered=${rendered//__BUCKET__/$bucket}
  rendered=${rendered//__PGHOST__/$host}
  rendered=${rendered//__PGPORT__/$port}
  rendered=${rendered//__PGDB__/$database}
  rendered=${rendered//__PGUSER__/$user}

  # The pre-existing bucket bug was a placeholder nobody substituted, so the
  # renderer refuses to emit one rather than letting the node discover it.
  if [[ $rendered == *__* ]]; then
    echo "render_remote_migration: unsubstituted placeholder in rendered script" >&2
    printf '%s\n' "$rendered" | grep -n '__' >&2
    return 1
  fi

  printf '%s\n' "$rendered"
}

# assert_atlas_project DB_DIR
#
# The remote script runs `atlas migrate status --env ci`, so the packaged
# atlas.hcl has to declare that env. Checked here, in a second, rather than
# discovered on the node after the tarball has been built, uploaded to S3 and
# carried through an SSM round trip: without it the node fails two minutes in
# on `project file ... does not define env "ci"`, which reads like a broken
# instance rather than a missing block in a file on this machine.
assert_atlas_project() {
  local db_dir=$1

  if [[ ! -d "$db_dir/atlas/migrations" ]]; then
    echo "error: no atlas/migrations under $db_dir" >&2
    return 1
  fi

  if [[ ! -f "$db_dir/atlas.hcl" ]]; then
    echo "error: no atlas.hcl under $db_dir" >&2
    echo "error: the tarball carries it to the node, which cannot run atlas without it" >&2
    return 1
  fi

  # `grep`, not `rg`: this predicate is also the shape the node would need,
  # and a project file is small enough that the difference is unmeasurable.
  if ! grep -q 'env "ci"' "$db_dir/atlas.hcl"; then
    echo "error: $db_dir/atlas.hcl does not declare env \"ci\"" >&2
    echo "error: the remote script runs 'atlas migrate status --env ci' and would fail on the node" >&2
    return 1
  fi
}

# truncation_note LABEL LENGTH
#
# ssm get-command-invocation returns at most 24,000 characters of each stream
# and says nothing when it cuts. On an apply that ceiling lands in the middle
# of the record — the list of migrations that actually ran against production
# — so a truncated stream must not be read as the whole account of what
# happened. Prints nothing when the stream fitted.
truncation_note() {
  local label=$1 length=$2

  if [[ $length -ge 24000 ]]; then
    echo "==> WARNING: $label hit SSM's 24,000-character cap and is truncated." >&2
    echo "==> WARNING: this is not the whole record of what ran. Read the full" >&2
    echo "==> WARNING: output on the node before treating this as the account." >&2
  fi
}

# invocation_verdict STATUS TIMED_OUT COMMAND_ID INSTANCE REGION SECONDS
#
# How the SSM command ended, and the exit code that goes with it: 0 the
# migration succeeded, 1 it failed, 2 it is still running and this script gave
# up waiting.
#
# The third case used to be reported as the second. Running out of polls left
# STATUS at `InProgress`, which is not `Success`, so the script said "FAILED
# ... finished as InProgress" — about a command that had not finished and was
# very likely still applying. That reading invites the one action that must
# not follow: re-running the script. A second apply over one still in flight
# is how a schema gets migrated halfway twice, and Atlas cannot undo it.
invocation_verdict() {
  local status=$1 timed_out=$2 command_id=$3 instance=$4 region=$5 seconds=$6

  if [[ $timed_out == "1" ]]; then
    echo "==> STILL RUNNING after ${seconds}s. This is NOT a failure." >&2
    echo "==> Command $command_id is still executing on $instance and the" >&2
    echo "==> migration may be mid-apply." >&2
    echo "==> Do NOT re-run this script. Watch the command instead:" >&2
    echo "==>   aws ssm get-command-invocation --region $region \\" >&2
    echo "==>     --command-id $command_id --instance-id $instance" >&2
    return 2
  fi

  if [[ $status != "Success" ]]; then
    echo "==> FAILED: ssm command $command_id finished as $status" >&2
    return 1
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Everything above is definitions; everything below runs.
#
# infra/tools/tests/render-remote-migration.test.sh sources this file to render
# the remote script and read it, which is the only way to check what will run on
# the node without an account to run it in. Returning here is what makes that
# safe: a source gets the function and none of the SSM calls.
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0
fi

set -euo pipefail

APPLY=0
DB_DIR_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    -h|--help)
      echo "usage: $0 <packages/database dir> [--apply]" >&2
      exit 0
      ;;
    -*)
      echo "error: unknown option $1" >&2
      echo "usage: $0 <packages/database dir> [--apply]" >&2
      exit 2
      ;;
    *)
      if [[ -n $DB_DIR_ARG ]]; then
        echo "error: unexpected argument $1" >&2
        exit 2
      fi
      DB_DIR_ARG=$1
      shift
      ;;
  esac
done

if [[ -z $DB_DIR_ARG ]]; then
  echo "usage: $0 <packages/database dir> [--apply]" >&2
  exit 2
fi

DB_DIR=$(cd "$DB_DIR_ARG" && pwd)
REGION=us-east-1

# The current account (916294258235). Both values are copied from
# stacks-new/ci-deploy: node_instance_id in terraform.tfvars, and the bucket
# aws_s3_bucket.deploy builds as oxagen-deploy-<account_id>.
# Resolved by tag, not pinned to an id. The node is replaced whenever its user
# data changes, and on 2026-09-08 a replacement left every hardcoded copy of
# this id pointing at a terminated box. Override with INSTANCE=... for the old
# account's node, which carries a different tag.
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

CLUSTER=${CLUSTER:-oxagen-postgres}
PGDB=${PGDB:-oxagen}
PGUSER=${PGUSER:-oxagen}

# Off by default. --allow-dirty lets Atlas apply over a schema holding objects
# its revision table does not know about, which is the right answer exactly
# once — the first apply against a cluster something else already populated —
# and a way to double-create objects every other time.
ALLOW_DIRTY=${ALLOW_DIRTY:-0}

assert_atlas_project "$DB_DIR" || exit 1

# Resolving the endpoint here is also the cheapest proof that the caller's
# credentials reach the right account: the cluster is only in 916294258235.
if [[ -n ${AURORA_ENDPOINT:-} ]]; then
  PGHOST=$AURORA_ENDPOINT
  PGPORT=${AURORA_PORT:-5432}
  echo "==> using AURORA_ENDPOINT from the environment"
else
  echo "==> resolving the $CLUSTER writer endpoint"
  read -r PGHOST PGPORT < <(
    aws rds describe-db-clusters --region "$REGION" \
      --db-cluster-identifier "$CLUSTER" \
      --query 'DBClusters[0].[Endpoint,Port]' --output text
  ) || true
fi

if [[ -z ${PGHOST:-} || $PGHOST == "None" ]]; then
  echo "error: could not resolve the writer endpoint for cluster '$CLUSTER' in $REGION." >&2
  echo "error: the cluster lives in account 916294258235 — check which account these credentials reach." >&2
  echo "error: set AURORA_ENDPOINT to skip this lookup." >&2
  exit 1
fi
PGPORT=${PGPORT:-5432}
echo "==> cluster $CLUSTER on port $PGPORT"

# A dead or unregistered instance otherwise costs ten minutes of polling and
# then reports "InProgress", which reads as slow rather than as wrong.
ONLINE=$(aws ssm describe-instance-information --region "$REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE" \
  --query 'length(InstanceInformationList)' --output text 2>/dev/null || echo 0)
if [[ $ONLINE != "1" ]]; then
  echo "error: instance $INSTANCE is not registered with SSM in $REGION." >&2
  echo "error: nothing can run on it, so this would poll and then time out." >&2
  exit 1
fi

TARBALL="${TMPDIR:-/tmp}/atlas-migrations.tgz"
rm -f "$TARBALL"

# COPYFILE_DISABLE stops macOS tar writing an AppleDouble `._name` sidecar for
# every file carrying extended attributes. Atlas hashes the whole migration
# directory, so those sidecars land as unknown migration files and every
# command fails with "checksum mismatch" naming a `._` file that was never
# authored.
COPYFILE_DISABLE=1 tar --exclude '._*' --exclude '.DS_Store' \
  -czf "$TARBALL" -C "$DB_DIR" atlas atlas.hcl
echo "==> packaged $(find "$DB_DIR/atlas/migrations" -name '*.sql' | wc -l | tr -d ' ') migrations"

aws s3 cp "$TARBALL" "s3://$BUCKET/_deploy/atlas-migrations.tgz" --only-show-errors
echo "==> uploaded to s3://$BUCKET/_deploy/"

REMOTE_FILE=$(mktemp "${TMPDIR:-/tmp}/mig-remote-XXXXXX")
PARAMS_FILE=$(mktemp "${TMPDIR:-/tmp}/mig-params-XXXXXX")
trap 'rm -f "$REMOTE_FILE" "$PARAMS_FILE"' EXIT

render_remote_migration \
  "$BUCKET" "$PGHOST" "$PGPORT" "$PGDB" "$PGUSER" "$APPLY" "$ALLOW_DIRTY" \
  > "$REMOTE_FILE"

if [[ $APPLY == "1" ]]; then
  echo "==> APPLYING migrations"
else
  echo "==> dry run (status only); pass --apply to apply"
fi

python3 - "$REMOTE_FILE" "$PARAMS_FILE" <<'PY'
import json, sys
json.dump({"commands": open(sys.argv[1]).read().splitlines()}, open(sys.argv[2], "w"))
PY

CMD=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --parameters "file://$PARAMS_FILE" \
  --query 'Command.CommandId' --output text)
echo "==> ssm command $CMD"

# A ten-minute ceiling, and reaching it is its own outcome rather than a
# failure — see invocation_verdict. Raise it with POLLS for a migration known
# to be long; each poll is ten seconds.
POLLS=${POLLS:-60}
TIMED_OUT=1
st=Pending
for _ in $(seq 1 "$POLLS"); do
  st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  if [[ $st != InProgress && $st != Pending ]]; then
    TIMED_OUT=0
    break
  fi
  sleep 10
done
echo "==> $st"

# Captured rather than piped straight to `tail` so its length can be measured:
# the cap SSM applies is silent, and a truncated apply record read as complete
# is the failure mode worth catching here.
for stream in StandardOutputContent StandardErrorContent; do
  content=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" \
    --instance-id "$INSTANCE" --query "$stream" --output text 2>/dev/null || true)
  label=stdout
  [[ $stream == StandardErrorContent ]] && label=stderr
  echo "--- $label ---"
  printf '%s\n' "$content" | tail -20
  truncation_note "$label" "${#content}"
done

# A migration that failed used to leave this script exiting 0, so the caller —
# and anything wrapping it — read a failed apply as a successful one. The
# outcome is the result, so it is the exit code.
invocation_verdict "$st" "$TIMED_OUT" "$CMD" "$INSTANCE" "$REGION" "$((POLLS * 10))"
exit $?
