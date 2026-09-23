#!/usr/bin/env bash
#
# Holds the production migration path to the account it actually runs in.
#
# Every assertion here fails against the pre-#2652 script, which targeted the
# retired account: it exec'd into a Postgres container that the current node
# does not run, read the password from a parameter path that no longer exists,
# and connected to localhost. None of that can be caught by running the script,
# because running it needs the very account whose shape is in question — so the
# rendered text is the thing under test.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOLS=$(cd "$HERE/.." && pwd)

# Sourcing returns before the script's own body runs — see its source guard.
# shellcheck source=infra/tools/run-db-migrations.sh
source "$TOOLS/run-db-migrations.sh"

FAILED=0
CASES=0

pass() { CASES=$((CASES + 1)); }
fail() {
  CASES=$((CASES + 1))
  FAILED=$((FAILED + 1))
  echo "FAIL: $1" >&2
}

contains() {
  local haystack=$1 needle=$2 label=$3
  case "$haystack" in
    *"$needle"*) pass ;;
    *) fail "$label — expected to find: $needle" ;;
  esac
}

lacks() {
  local haystack=$1 needle=$2 label=$3
  case "$haystack" in
    *"$needle"*) fail "$label — expected NOT to find: $needle" ;;
    *) pass ;;
  esac
}

# --- the rendered remote script -------------------------------------------

DRY=$(render_remote_migration \
  "test-bucket" "clus.example.rds.amazonaws.com" "5432" "oxagen" "oxagen" "0" "0")

lacks "$DRY" "docker exec" "dry run: no docker exec anywhere"
lacks "$DRY" "/oxagen-data/postgres/password" "dry run: retired parameter path is gone"
contains "$DRY" "/oxagen-app/postgres/password" "dry run: reads the current parameter path"
lacks "$DRY" "localhost:5432" "dry run: does not connect to loopback"
contains "$DRY" "@clus.example.rds.amazonaws.com:5432/oxagen" "dry run: connects to the given endpoint"
contains "$DRY" "sslmode=require" "dry run: requires TLS"

# The connection carries the RLS bypass, and it is the reason a managed cluster
# can run this directory at all (#1368). Aurora has no superuser, so nothing
# bypasses RLS for free; the seed in 20260614000000 inserts mcp.registries'
# global row with org_id = NULL, and the tenant_isolation policy in force at
# that point in the history has the `org_id IS NULL` arm in USING and not in
# WITH CHECK. Without the GUC the apply stops there, 42501, on file 14 of the
# directory. Atlas replays in version order, so no forward migration can reach
# back and fix the policy the seed runs under — the connection is the only
# place this can live, which is why it is asserted here rather than in SQL.
contains "$DRY" "app.rls_bypass" "dry run: the migration connection carries the RLS bypass"
contains "$DRY" "options=-c%20app.rls_bypass%3Don" \
  "dry run: the bypass is percent-encoded, as a URL query value must be"
contains "$DRY" "sslmode=require&options=" \
  "dry run: appended to the existing query string with & rather than a second ?"
# A raw space or a raw `=` in the value would be read as URL structure and the
# parameter would arrive malformed or not at all — a failure that looks like
# the policy refusing the row rather than like a broken connection string.
lacks "$DRY" "options=-c app.rls_bypass=on" "dry run: the bypass is not left unencoded"

# The bug that split this file out: the upload used a variable and the
# download used a literal, so they could name different buckets.
contains "$DRY" "s3://test-bucket/_deploy/atlas-migrations.tgz" "dry run: bucket substituted into the download"
UNIQUE=$(render_remote_migration \
  "test-bucket" "clus.example.rds.amazonaws.com" "5432" "oxagen" "oxagen" "0" "0" "0" \
  "atlas-migrations-abc123.tgz")
contains "$UNIQUE" "s3://test-bucket/_deploy/atlas-migrations-abc123.tgz" \
  "dry run: a per-run object name is what the node downloads"
lacks "$UNIQUE" "/_deploy/atlas-migrations.tgz" "dry run: the per-run name replaces the shared key"
if render_remote_migration \
  "test-bucket" "clus.example.rds.amazonaws.com" "5432" "oxagen" "oxagen" "0" "0" "0" \
  "../atlas-migrations.tgz" >/dev/null 2>&1; then
  fail "an object name outside the per-run pattern should be refused"
else
  pass
fi
KEY_A=$(migration_object_key)
KEY_B=$(migration_object_key)
if [[ $KEY_A =~ ^[0-9a-f]{16}$ && $KEY_A != "$KEY_B" ]]; then
  pass
else
  fail "migration_object_key should be 16 hex chars and differ per call (got '$KEY_A' and '$KEY_B')"
fi
RUNNER=$(sed -n '/^# Everything above is definitions/,$p' "$TOOLS/run-db-migrations.sh")
contains "$RUNNER" 'migration_object_key' "runner: each invocation names its own object"
lacks "$RUNNER" '_deploy/atlas-migrations.tgz' "runner: does not upload the shared key"
contains "$RUNNER" 's3 rm' "runner: deletes the object after the node has finished"
contains "$RUNNER" '${TIMED_OUT:-0} == 1' \
  "runner: a command that is still running keeps its archive"
lacks "$DRY" "oxagen-deploy-578673726240" "dry run: no hardcoded old-account bucket"
lacks "$DRY" "__" "dry run: no placeholder survives"

# Each invocation unpacks into its own directory on the node, named after its
# object. With one shared /opt/oxagen/db, a status-only gate on main ran
# `rm -rf` over the seed a concurrent apply had bind-mounted into its
# container. The shared name still renders, into a directory of its own.
contains "$DRY" "run_dir=/opt/oxagen/db/atlas-migrations" \
  "dry run: the legacy object name unpacks into its own directory"
contains "$UNIQUE" "run_dir=/opt/oxagen/db/atlas-migrations-abc123" \
  "dry run: a per-run object unpacks into a per-run directory"
lacks "$DRY" "/tmp/atlas.tgz" "dry run: the download is not a shared /tmp path either"
contains "$DRY" "trap 'rm -rf \"\$run_dir\" \"\$run_dir.tgz\"' EXIT" \
  "dry run: the node keeps nothing from a run"

# The password is read on the node, never here.
contains "$DRY" "set +x" "dry run: tracing is turned off around the secret"

# A dry run must not apply.
lacks "$DRY" "atlas migrate apply --env ci" "dry run: does not apply"
lacks "$DRY" "platform-seed.mjs" "dry run: does not seed"
contains "$DRY" "atlas migrate status --env ci" "dry run: reports status"

APPLY=$(render_remote_migration \
  "test-bucket" "clus.example.rds.amazonaws.com" "5432" "oxagen" "oxagen" "1" "0")
contains "$APPLY" "atlas migrate apply --env ci" "apply: applies"
contains "$APPLY" "node /seed/src/platform-seed.mjs" "apply: seeds platform defaults"
contains "$APPLY" "--env DATABASE_URL" "apply: passes credential by name"
contains "$APPLY" "src=/opt/oxagen/db/atlas-migrations,dst=/seed" \
  "apply: the seed container mounts this run's own directory"
lacks "$APPLY" "src=/opt/oxagen/db,dst=/seed" \
  "apply: the seed container does not mount the shared directory a gate can clear"
# The apply is the run that actually meets the seed, so it is the one that must
# carry the bypass. Asserted separately from the dry run because the two are
# rendered down different branches.
contains "$APPLY" "options=-c%20app.rls_bypass%3Don" "apply: carries the RLS bypass"
lacks "$APPLY" "--allow-dirty" "apply: clean by default"

DIRTY=$(render_remote_migration \
  "test-bucket" "clus.example.rds.amazonaws.com" "5432" "oxagen" "oxagen" "1" "1")
contains "$DIRTY" "atlas migrate apply --env ci --allow-dirty" "apply: --allow-dirty is opt-in"

lacks "$APPLY" "--exec-order" "apply: linear by default"
NON_LINEAR=$(render_remote_migration \
  "test-bucket" "clus.example.rds.amazonaws.com" "5432" "oxagen" "oxagen" "1" "0" "1")
contains "$NON_LINEAR" "atlas migrate apply --env ci --exec-order non-linear" "apply: non-linear order is opt-in"
DRY_NON_LINEAR=$(render_remote_migration \
  "test-bucket" "clus.example.rds.amazonaws.com" "5432" "oxagen" "oxagen" "0" "0" "1")
lacks "$DRY_NON_LINEAR" "atlas migrate apply" "dry run: non-linear still applies nothing"

# An empty argument renders a script that fails on the wrong thing.
if render_remote_migration "" "h" "5432" "d" "u" "0" "0" >/dev/null 2>&1; then
  fail "empty bucket should be refused"
else
  pass
fi
if render_remote_migration "b" "h" "5432" "d" "u" "0" >/dev/null 2>&1; then
  fail "wrong argument count should be refused"
else
  pass
fi

# --- writer host, without calling AWS -------------------------------------
#
# The deploy role cannot call rds:DescribeDBClusters. The first migration
# gate on main reported Postgres unknown because the status script used that
# call and nothing else. The host has to come from the parameter first.

HOST=$(postgres_host_from_url \
  "postgres://oxagen:s3cret@oxagen-postgres.cluster-abc.us-east-1.rds.amazonaws.com:5432/oxagen?sslmode=require")
contains "$HOST" "oxagen-postgres.cluster-abc.us-east-1.rds.amazonaws.com 5432" \
  "url: host and explicit port"
lacks "$HOST" "s3cret" "url: password stays out of the host line"

DEFAULT_PORT=$(postgres_host_from_url "postgresql://oxagen:s3cret@writer.example/oxagen")
contains "$DEFAULT_PORT" "writer.example 5432" "url: missing port is 5432"

AT_IN_PASSWORD=$(postgres_host_from_url "postgres://oxagen:p%40ss@writer.example:5432/oxagen")
contains "$AT_IN_PASSWORD" "writer.example 5432" "url: an encoded @ stays in the userinfo"

REFUSED=$(postgres_host_from_url "mysql://user:supersecret@writer.example/oxagen" 2>&1 >/dev/null || true)
contains "$REFUSED" "expected a postgres URL" "url: a non-postgres scheme is refused"
lacks "$REFUSED" "supersecret" "url: a refusal does not repeat the password"

NO_DB=$(postgres_host_from_url "postgres://oxagen:s3cret@writer.example" 2>&1 >/dev/null || true)
contains "$NO_DB" "no database name" "url: a URL with no database is refused"

ENV_WINS=$(writer_from_sources "from-env.example" "5433" \
  "postgres://oxagen:s3cret@from-param.example/oxagen" "from-describe.example 5432")
contains "$ENV_WINS" "env from-env.example 5433" "sources: AURORA_ENDPOINT wins"
lacks "$ENV_WINS" "s3cret" "sources: the unused URL's password is not printed"
lacks "$ENV_WINS" "from-param" "sources: a set endpoint ignores the parameter"

PARAM_WINS=$(writer_from_sources "" "" \
  "postgres://oxagen:s3cret@from-param.example:5432/oxagen" "from-describe.example 5432")
contains "$PARAM_WINS" "parameter from-param.example 5432" "sources: the parameter beats describe"
lacks "$PARAM_WINS" "from-describe" "sources: describe is not used when the URL parses"
lacks "$PARAM_WINS" "s3cret" "sources: the parameter password is not printed"

BAD_URL=$(writer_from_sources "" "" "not a url" "from-describe.example 5432" 2>/dev/null)
contains "$BAD_URL" "describe from-describe.example 5432" \
  "sources: an unusable parameter falls through to describe"

NONE_FIELD=$(writer_from_sources "" "" "" "None None" 2>&1 || true)
contains "$NONE_FIELD" "no writer endpoint" "sources: AWS's None is not a host"

if writer_from_sources "" "" "" "" >/dev/null 2>&1; then
  fail "sources: nothing at all should be refused"
else
  pass
fi

# --- the shipped outer script ---------------------------------------------

SCRIPT=$(cat "$TOOLS/run-db-migrations.sh")

lacks "$SCRIPT" "docker exec" "script: no docker exec anywhere"
lacks "$SCRIPT" "i-023d002d6e44f8f84" "script: retired instance is gone"
lacks "$SCRIPT" "oxagen-deploy-578673726240" "script: retired deploy bucket is gone"
lacks "$SCRIPT" "i-094fcb34c7e715cf8" "script: pins no instance id"
contains "$SCRIPT" "tag:Name,Values=" "script: resolves the app node by tag"
contains "$SCRIPT" "oxagen-deploy-916294258235" "script: targets the current deploy bucket"
contains "$SCRIPT" "oxagen-postgres" "script: names the Aurora cluster"
contains "$SCRIPT" 'AURORA_URL_PARAMETER:-/oxagen/production/DATABASE_URL' \
  "script: reads the writer host from the parameter the deploy role can get"
param_line=$(grep -n 'AURORA_URL_PARAMETER:-/oxagen/production/DATABASE_URL' \
  "$TOOLS/run-db-migrations.sh" | head -1 | cut -d: -f1)
desc_line=$(grep -n 'aws rds describe-db-clusters' \
  "$TOOLS/run-db-migrations.sh" | head -1 | cut -d: -f1)
if [[ -n $param_line && -n $desc_line && $param_line -lt $desc_line ]]; then
  pass
else
  fail "script: the parameter read must come before describe-db-clusters (param=$param_line describe=$desc_line)"
fi

# --- how the SSM invocation is judged --------------------------------------
#
# Behaviour, not text: these three endings are the script's contract with
# whatever runs it, and the middle one used to be wrong. Running out of polls
# left the status at `InProgress`, which is not `Success`, so a command that
# had not finished was reported as one that had failed — and the obvious
# response to a failed migration is to run it again, over an apply still in
# flight.

verdict_code() {
  invocation_verdict "$@" >/dev/null 2>&1
  echo $?
}

verdict_stderr() {
  invocation_verdict "$@" 2>&1 >/dev/null
}

expect_code() {
  local want=$1 got=$2 label=$3
  if [[ $want == "$got" ]]; then pass; else fail "$label — wanted exit $want, got $got"; fi
}

expect_code 0 "$(verdict_code Success 0 cmd-1 i-abc us-east-1 600)" \
  "a completed successful invocation exits 0"
expect_code 1 "$(verdict_code Failed 0 cmd-1 i-abc us-east-1 600)" \
  "a completed failed invocation exits 1"
expect_code 1 "$(verdict_code TimedOut 0 cmd-1 i-abc us-east-1 600)" \
  "SSM's own TimedOut is a completed failure and exits 1"
expect_code 2 "$(verdict_code InProgress 1 cmd-1 i-abc us-east-1 600)" \
  "giving up waiting is its own outcome and exits 2, not 1"

# The distinction is only useful if the message carries it. A run that gave up
# waiting must say the command is still going and must say not to re-run.
STILL=$(verdict_stderr InProgress 1 cmd-1 i-abc us-east-1 600)
contains "$STILL" "NOT a failure" "still-running: says it is not a failure"
contains "$STILL" "Do NOT re-run" "still-running: forbids the dangerous next step"
contains "$STILL" "cmd-1" "still-running: names the command to watch"
contains "$STILL" "i-abc" "still-running: names the instance"
lacks "$STILL" "FAILED" "still-running: does not call itself a failure"

# --- whether the node is managed ------------------------------------------
#
# describe-instance-information is not granted to gha-deploy-oxagen-platform.
# Collapsing a non-zero exit into a count of zero made every migration gate
# say the node was unregistered (run 35674893025) and skip Atlas status.

expect_word() {
  local want=$1 got=$2 label=$3
  if [[ $want == "$got" ]]; then pass; else fail "$label: wanted '$want', got '$got'"; fi
}

expect_word online "$(classify_ssm_online 0 1)" \
  "one managed instance is online"
expect_word absent "$(classify_ssm_online 0 0)" \
  "a successful empty list is absent"
expect_word absent "$(classify_ssm_online 0 2)" \
  "more than one managed instance is not the node we asked for"
expect_word unreadable "$(classify_ssm_online 254 0)" \
  "AccessDenied is unreadable, not absent"
expect_word unreadable "$(classify_ssm_online 255 "")" \
  "a failed call with no count is unreadable"

contains "$RUNNER" "classify_ssm_online" \
  "runner: classifies the SSM lookup before deciding the node is dead"
lacks "$RUNNER" '|| echo 0' \
  "runner: a denied SSM read is not rewritten as a count of zero"

# --- how one status poll is read -------------------------------------------
#
# The poll used to send stderr to /dev/null and rewrite every non-zero exit as
# Pending. A denied get-command-invocation then spent the full poll budget and
# reported STILL RUNNING about a command it had never observed. Only the
# window after send-command, when SSM has not yet registered the invocation,
# is a pending answer; every other failure is unreadable, not a status.

expect_word done "$(classify_invocation_poll 0 Success "")" \
  "a finished command is done"
expect_word done "$(classify_invocation_poll 0 Failed "")" \
  "a failed command is done, and the verdict reads it"
expect_word pending "$(classify_invocation_poll 0 InProgress "")" \
  "InProgress keeps polling"
expect_word pending "$(classify_invocation_poll 0 Pending "")" \
  "Pending keeps polling"
expect_word pending "$(classify_invocation_poll 0 Delayed "")" \
  "Delayed keeps polling"
expect_word pending "$(classify_invocation_poll 254 "" \
  "An error occurred (InvocationDoesNotExist) when calling the GetCommandInvocation operation")" \
  "an invocation SSM has not registered yet is pending"
expect_word unreadable "$(classify_invocation_poll 254 "" \
  "An error occurred (AccessDeniedException) when calling the GetCommandInvocation operation")" \
  "AccessDenied is unreadable, not pending"
expect_word unreadable "$(classify_invocation_poll 255 "" "")" \
  "a failed poll with no message is unreadable"

contains "$RUNNER" "classify_invocation_poll" \
  "runner: classifies each poll before reading it as a status"
lacks "$RUNNER" '|| echo Pending' \
  "runner: a failed poll is not rewritten as Pending"
contains "$RUNNER" "Do NOT re-run this script. Watch the command instead" \
  "runner: an unreadable poll forbids the dangerous next step"

FAILED_MSG=$(verdict_stderr Failed 0 cmd-2 i-abc us-east-1 600)
contains "$FAILED_MSG" "FAILED" "failed: says so"
lacks "$FAILED_MSG" "Do NOT re-run" "failed: a real failure may be re-run once fixed"

# --- the silent output cap -------------------------------------------------
#
# ssm get-command-invocation returns at most 24,000 characters per stream and
# does not say when it cut. On an apply that ceiling lands in the middle of
# the list of migrations that ran against production.

SHORT=$(truncation_note stdout 100 2>&1)
[[ -z $SHORT ]] && pass || fail "a stream that fitted must produce no warning, got: $SHORT"

CUT=$(truncation_note stdout 24000 2>&1)
contains "$CUT" "truncated" "at the cap: warns the record is incomplete"
contains "$CUT" "stdout" "at the cap: names the stream"

# --- the atlas project the node is handed ----------------------------------
#
# Checked here rather than on the node: without env "ci" the remote fails two
# minutes in, after a tarball, an S3 upload and an SSM round trip, on a
# message about a project file that reads like a broken instance.

FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/atlas-fixture-XXXXXX")
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/good/atlas/migrations"
printf 'env "ci" {\n  url = getenv("DATABASE_URL")\n}\n' > "$FIXTURE/good/atlas.hcl"
assert_atlas_project "$FIXTURE/good" 2>/dev/null && pass || fail "a complete project is accepted"

mkdir -p "$FIXTURE/no-hcl/atlas/migrations"
assert_atlas_project "$FIXTURE/no-hcl" 2>/dev/null && fail "a project with no atlas.hcl must be refused" || pass

mkdir -p "$FIXTURE/no-ci/atlas/migrations"
printf 'env "local" {\n  url = "postgres://localhost/x"\n}\n' > "$FIXTURE/no-ci/atlas.hcl"
assert_atlas_project "$FIXTURE/no-ci" 2>/dev/null && fail "an atlas.hcl without env \"ci\" must be refused" || pass
NO_CI=$(assert_atlas_project "$FIXTURE/no-ci" 2>&1)
contains "$NO_CI" 'env "ci"' "no ci env: the message names what is missing"

mkdir -p "$FIXTURE/no-migrations"
printf 'env "ci" {}\n' > "$FIXTURE/no-migrations/atlas.hcl"
assert_atlas_project "$FIXTURE/no-migrations" 2>/dev/null && fail "a project with no migrations dir must be refused" || pass

# The real database package is the thing this actually ships, so check it too.
REPO=$(cd "$TOOLS/../.." && pwd)
if [[ -d "$REPO/packages/database/atlas/migrations" ]]; then
  assert_atlas_project "$REPO/packages/database" 2>/dev/null \
    && pass || fail "packages/database does not satisfy the check the script makes of it"
fi

# --- result ---------------------------------------------------------------

if [[ $FAILED -gt 0 ]]; then
  echo "render-remote-migration: $FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "render-remote-migration: $CASES assertions passed"
