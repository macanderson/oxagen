#!/usr/bin/env bash
#
# Apply Atlas migrations and seed platform defaults in production Aurora.
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
# export. Apply runs also carry a bundled seedPlatform entry and its assets,
# executed in the same pinned Node container image used by the platform.
# The app node needs Docker, but no workspace or Node installation.
#
# The cluster endpoint is resolved HERE and substituted into the remote
# script, not looked up on the node. The node's role has no RDS permissions
# (infra/modules/app-node/main.tf). The deploy role has no rds:Describe*
# either, so the host comes from /oxagen/production/DATABASE_URL, which that
# role can already read. describe-db-clusters is the fallback. The password
# is read on the node, inside a tracing-off window, so it never reaches this
# machine.

# migration_object_key
#
# Sixteen hex characters. Each invocation uploads its own object. Two
# migration gates on main can overlap, and a shared `atlas-migrations.tgz`
# lets a newer commit classify status taken against an older directory.
migration_object_key() {
  od -An -N8 -tx1 /dev/urandom | tr -d ' \n'
}

# visible_stream CONTENT
#
# The last 20 lines of an SSM stream, then the Atlas status block again.
# Atlas prints `Migration Status:` before the pending-file list, and a list
# longer than the tail drops that line. The classifier must still see it.
visible_stream() {
  local content=$1
  printf '%s\n' "$content" | tail -20
  # Repeated after the tail. `head -1` in the classifier keeps the first
  # copy when the tail still holds it, and this copy when the tail dropped it.
  printf '%s\n' "$content" | grep -E \
    '^[[:space:]]*(Migration Status:|--[[:space:]]*(Executed Files|Pending Files):)' || true
}

# render_remote_migration BUCKET HOST PORT DATABASE USER APPLY ALLOW_DIRTY [NON_LINEAR] [OBJECT]
#
# APPLY is "1" to apply, anything else for a status-only dry run.
# ALLOW_DIRTY is "1" to pass --allow-dirty to `atlas migrate apply`.
# NON_LINEAR is "1" to pass --exec-order non-linear; it defaults to "0".
# OBJECT is the tarball name under `_deploy/`. It defaults to the historical
# shared name so a caller that has not been updated still renders. The runner
# below always passes a per-invocation name from `migration_object_key`.
# Writes the rendered script to stdout. Fails if any placeholder survives.
render_remote_migration() {
  if [[ $# -ne 7 && $# -ne 8 && $# -ne 9 ]]; then
    echo "render_remote_migration: expected 7, 8, or 9 arguments, got $#" >&2
    return 2
  fi

  local bucket=$1 host=$2 port=$3 database=$4 user=$5 apply=$6 allow_dirty=$7
  local non_linear=${8:-0}
  local object=${9:-atlas-migrations.tgz}
  local arg name

  if [[ $object != "atlas-migrations.tgz" && ! $object =~ ^atlas-migrations-[0-9a-f]+[.]tgz$ ]]; then
    echo "render_remote_migration: object must be atlas-migrations.tgz or atlas-migrations-<hex>.tgz" >&2
    return 2
  fi

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

  local order_flag=""
  [[ $non_linear == "1" ]] && order_flag="--exec-order non-linear"

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
aws s3 cp "s3://__BUCKET__/_deploy/__OBJECT__" /tmp/atlas.tgz --region us-east-1
rm -rf atlas atlas.hcl src seed-assets
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
    [[ -n $order_flag ]] && apply_line="$apply_line $order_flag"
    tail="$apply_line
# Seed only after a successful migration. Pass the credential by environment
# name so shell tracing never expands it into SSM output.
docker run --rm --network host --read-only \
  --mount type=bind,src=/opt/oxagen/db,dst=/seed,readonly \
  --env DATABASE_URL --env NODE_ENV=production \
  node:24.21.0-alpine node /seed/src/platform-seed.mjs
echo \"--- applied; status after apply (expect no pending) ---\"
atlas migrate status --env ci"
  else
    tail='echo "--- dry run: nothing was applied. Re-run with --apply. ---"'
  fi
  rendered=${rendered//__TAIL__/$tail}

  rendered=${rendered//__BUCKET__/$bucket}
  rendered=${rendered//__OBJECT__/$object}
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

# postgres_host_from_url URL
#
# Prints "host port" for a postgres or postgresql URL. The port defaults to
# 5432. A refusal does not repeat the URL: the production value is a
# connection string, and the password is in it.
postgres_host_from_url() {
  local url=$1
  local scheme rest hostport host port path database

  if [[ -z $url || $url == "None" ]]; then
    echo "error: postgres URL is empty" >&2
    return 1
  fi

  scheme=${url%%://*}
  case $scheme in
    postgres|postgresql) ;;
    *)
      echo "error: expected a postgres URL" >&2
      return 1
      ;;
  esac

  rest=${url#*://}
  # Userinfo ends at the last @. An unencoded @ inside a password is not legal
  # in a URL, and taking the first one would treat the rest of the password as
  # the host.
  if [[ $rest == *@* ]]; then
    rest=${rest##*@}
  fi
  hostport=${rest%%[/?]*}
  path=${rest#"$hostport"}
  database=${path#/}
  database=${database%%[/?]*}
  if [[ -z $database ]]; then
    echo "error: postgres URL has no database name" >&2
    return 1
  fi

  if [[ $hostport == *:* ]]; then
    host=${hostport%%:*}
    port=${hostport#*:}
  else
    host=$hostport
    port=5432
  fi

  if [[ ! $host =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
    echo "error: postgres URL host is not a DNS name" >&2
    return 1
  fi
  if [[ ! $port =~ ^[0-9]+$ ]]; then
    echo "error: postgres URL port is not a number" >&2
    return 1
  fi
  printf '%s %s\n' "$host" "$port"
}

# writer_from_sources ENDPOINT ENDPOINT_PORT URL DESCRIBED
#
# Picks the writer host. ENDPOINT wins, then a usable URL, then the
# "host port" text from describe-db-clusters. Prints "source host port".
# The URL's password never appears in the output.
writer_from_sources() {
  local endpoint=${1:-} endpoint_port=${2:-} url=${3:-} described=${4:-}
  local host port

  if [[ -n $endpoint ]]; then
    printf 'env %s %s\n' "$endpoint" "${endpoint_port:-5432}"
    return 0
  fi
  if [[ -n $url && $url != "None" ]]; then
    if read -r host port < <(postgres_host_from_url "$url"); then
      printf 'parameter %s %s\n' "$host" "$port"
      return 0
    fi
  fi
  read -r host port <<<"$described"
  # `None` is what --output text prints for a null field. It matches a DNS
  # name, and accepting it would send Atlas at a host that does not exist.
  if [[ $port == "None" ]]; then
    port=""
  fi
  if [[ -n $host && $host != "None" && $host =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
    printf 'describe %s %s\n' "$host" "${port:-5432}"
    return 0
  fi
  echo "error: no writer endpoint from the environment, the parameter, or describe-db-clusters" >&2
  return 1
}

# classify_ssm_online EXIT_CODE COUNT
#
# Turns one `describe-instance-information` result into online, absent, or
# unreadable.
#
# online: the API returned exactly one managed instance.
# absent: the API succeeded and that instance is not in the managed list.
#   SendCommand would then poll until timeout, so the caller stops.
# unreadable: the API call failed. That is not evidence the instance is
#   absent. gha-deploy-oxagen-platform can SendCommand and StartSession and
#   cannot DescribeInstanceInformation, so AccessDenied used to be rewritten
#   as a count of zero and reported as an unregistered node (run
#   35674893025) while the store tunnels on that same node were already open.
classify_ssm_online() {
  local exit_code=$1 count=${2:-}
  if [[ $exit_code -ne 0 ]]; then
    echo unreadable
    return 0
  fi
  if [[ $count == "1" ]]; then
    echo online
    return 0
  fi
  echo absent
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

# Off by default. NON_LINEAR=1 lets Atlas apply a pending file whose version
# is older than the last one applied. That happens when two PRs carry
# migrations and the later-numbered one reaches production first: the dry run
# reports "Pending Files: N (1 out of order)" and a plain apply refuses. Read
# the out-of-order file before setting this; it must not depend on anything
# the newer files changed.
NON_LINEAR=${NON_LINEAR:-0}

assert_atlas_project "$DB_DIR" || exit 1

# The deploy role has no rds:DescribeDBClusters. The first migration gate on
# main (run 35670778610) died on that call with AccessDenied and reported
# Postgres unknown, which blocks deploy-node even when Aurora is current.
# /oxagen/production/DATABASE_URL is the parameter the same role already reads
# for the ClickHouse coordinator lock. Its host is the writer. describe stays
# as the fallback for a laptop whose credentials can see the cluster and
# whose parameter is absent.
AURORA_URL_PARAMETER=${AURORA_URL_PARAMETER:-/oxagen/production/DATABASE_URL}
url=""
described=""
if [[ -z ${AURORA_ENDPOINT:-} ]]; then
  echo "==> reading the writer host from $AURORA_URL_PARAMETER"
  errf=$(mktemp)
  if url=$(aws ssm get-parameter --region "$REGION" \
    --name "$AURORA_URL_PARAMETER" --with-decryption \
    --query Parameter.Value --output text 2>"$errf"); then
    if [[ -n ${GITHUB_ACTIONS:-} && -n $url && $url != "None" ]]; then
      echo "::add-mask::$url"
    fi
  else
    echo "==> could not read $AURORA_URL_PARAMETER" >&2
    sed 's/^/    /' "$errf" >&2
    url=""
  fi
  rm -f "$errf"
  if [[ -z $url || $url == "None" ]] || ! postgres_host_from_url "$url" >/dev/null; then
    echo "==> resolving the $CLUSTER writer endpoint"
    errf=$(mktemp)
    described=$(aws rds describe-db-clusters --region "$REGION" \
      --db-cluster-identifier "$CLUSTER" \
      --query 'DBClusters[0].[Endpoint,Port]' --output text 2>"$errf") || described=""
    if [[ -z $described || $described == "None" ]]; then
      sed 's/^/    /' "$errf" >&2
    fi
    rm -f "$errf"
  fi
fi

if ! read -r writer_source PGHOST PGPORT < <(writer_from_sources \
  "${AURORA_ENDPOINT:-}" "${AURORA_PORT:-}" "$url" "$described"); then
  echo "error: could not resolve the writer endpoint for cluster '$CLUSTER' in $REGION." >&2
  echo "error: tried $AURORA_URL_PARAMETER, then rds:DescribeDBClusters." >&2
  echo "error: the cluster lives in account 916294258235. Check which account these credentials reach." >&2
  echo "error: set AURORA_ENDPOINT to skip both lookups." >&2
  unset url described
  exit 1
fi
unset url described
case $writer_source in
  env) echo "==> using AURORA_ENDPOINT from the environment" ;;
  parameter) echo "==> using the host from $AURORA_URL_PARAMETER" ;;
  describe) echo "==> using describe-db-clusters" ;;
esac
PGPORT=${PGPORT:-5432}
echo "==> cluster $CLUSTER on port $PGPORT"

# A dead or unregistered instance otherwise costs ten minutes of polling and
# then reports "InProgress", which reads as slow rather than as wrong.
# A failed lookup is not that case: classify_ssm_online keeps a denial from
# reading as "not registered".
ssm_err=$(mktemp)
set +e
ONLINE=$(aws ssm describe-instance-information --region "$REGION" \
  --filters "Key=InstanceIds,Values=$INSTANCE" \
  --query 'length(InstanceInformationList)' --output text 2>"$ssm_err")
ssm_exit=$?
set -e
case $(classify_ssm_online "$ssm_exit" "$ONLINE") in
  online)
    rm -f "$ssm_err"
    ;;
  absent)
    rm -f "$ssm_err"
    echo "error: instance $INSTANCE is not registered with SSM in $REGION." >&2
    echo "error: nothing can run on it, so this would poll and then time out." >&2
    exit 1
    ;;
  unreadable)
    echo "==> could not ask SSM whether $INSTANCE is online. Continuing." >&2
    echo "==> SendCommand is the check this role can make. A denial here is not an unregistered node." >&2
    sed 's/^/    /' "$ssm_err" >&2
    rm -f "$ssm_err"
    ;;
  *)
    rm -f "$ssm_err"
    echo "error: unexpected SSM online verdict for $INSTANCE." >&2
    exit 1
    ;;
esac

TARBALL="${TMPDIR:-/tmp}/atlas-migrations.tgz"
rm -f "$TARBALL"

# COPYFILE_DISABLE stops macOS tar writing an AppleDouble `._name` sidecar for
# every file carrying extended attributes. Atlas hashes the whole migration
# directory, so those sidecars land as unknown migration files and every
# command fails with "checksum mismatch" naming a `._` file that was never
# authored.
if [[ $APPLY == "1" ]]; then
  REPO_ROOT=$(cd "$DB_DIR/../.." && pwd)
  node "$REPO_ROOT/tools/scripts/build-platform-seed.mjs"
  COPYFILE_DISABLE=1 tar --exclude '._*' --exclude '.DS_Store' \
    -czf "$TARBALL" -C "$DB_DIR" atlas atlas.hcl \
    -C "$DB_DIR/dist/platform-seed" src seed-assets
else
  COPYFILE_DISABLE=1 tar --exclude '._*' --exclude '.DS_Store' \
    -czf "$TARBALL" -C "$DB_DIR" atlas atlas.hcl
fi
echo "==> packaged $(find "$DB_DIR/atlas/migrations" -name '*.sql' | wc -l | tr -d ' ') migrations"

# One object per run. A fixed key lets a later gate download an earlier
# commit's directory and read Atlas OK as "this commit is deployed".
OBJECT_NAME="atlas-migrations-$(migration_object_key).tgz"
UPLOADED=0
# 0 until send-command returns. An exit before that has no remote command,
# so the archive is deleted. After the command exists this stays 1 until a
# terminal status, and the archive stays with it: a command that is still
# queued, or still downloading, fails if the object disappears.
TIMED_OUT=0
REMOTE_FILE=$(mktemp "${TMPDIR:-/tmp}/mig-remote-XXXXXX")
PARAMS_FILE=$(mktemp "${TMPDIR:-/tmp}/mig-params-XXXXXX")
cleanup_migration_object() {
  rm -f "${REMOTE_FILE:-}" "${PARAMS_FILE:-}" "${TARBALL:-}"
  if [[ ${UPLOADED:-0} != 1 || -z ${BUCKET:-} || -z ${OBJECT_NAME:-} ]]; then
    return 0
  fi
  if [[ ${TIMED_OUT:-0} == 1 ]]; then
    echo "==> leaving s3://$BUCKET/_deploy/$OBJECT_NAME in place." >&2
    echo "==> The SSM command is still running and may not have downloaded it yet." >&2
    return 0
  fi
  aws s3 rm "s3://$BUCKET/_deploy/$OBJECT_NAME" --only-show-errors || true
}
trap cleanup_migration_object EXIT

aws s3 cp "$TARBALL" "s3://$BUCKET/_deploy/$OBJECT_NAME" --only-show-errors
UPLOADED=1
echo "==> uploaded to s3://$BUCKET/_deploy/$OBJECT_NAME"

render_remote_migration \
  "$BUCKET" "$PGHOST" "$PGPORT" "$PGDB" "$PGUSER" "$APPLY" "$ALLOW_DIRTY" "$NON_LINEAR" \
  "$OBJECT_NAME" \
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
TIMED_OUT=1
echo "==> ssm command $CMD"

# A ten-minute ceiling, and reaching it is its own outcome rather than a
# failure — see invocation_verdict. Raise it with POLLS for a migration known
# to be long; each poll is ten seconds.
POLLS=${POLLS:-60}
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
  visible_stream "$content"
  truncation_note "$label" "${#content}"
done

# A migration that failed used to leave this script exiting 0, so the caller —
# and anything wrapping it — read a failed apply as a successful one. The
# outcome is the result, so it is the exit code.
invocation_verdict "$st" "$TIMED_OUT" "$CMD" "$INSTANCE" "$REGION" "$((POLLS * 10))"
exit $?
