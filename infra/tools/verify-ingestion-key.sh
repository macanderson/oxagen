#!/usr/bin/env bash
#
# Prove which KMS key production actually wraps connector credentials with,
# and that it can call it.
#
#   infra/tools/verify-ingestion-key.sh [service]     # default: api
#
# This is the witness check #2680 asks for, made runnable. The issue's own
# wording — "pick one existing stored connector credential, confirm it still
# decrypts" — cannot be satisfied literally: on 2026-09-09 every ciphertext
# column in production was empty, because nothing in 916294258235 had ever
# been able to encrypt. The old key's policy admits only 578673726240's root,
# so the configured key was one the platform could never call. There is no
# old-key ciphertext to decrypt, which is also why no re-wrap was needed.
#
# What can be witnessed instead, and is stronger than reading a parameter: the
# key the RUNNING PROCESS holds, and a round trip through it.
#
# Three things get read, because two of them disagree in the failure this
# exists to catch:
#
#   1. /oxagen/production/AWS_KMS_INGESTION_KEY_ARN in Parameter Store.
#   2. AWS_KMS_INGESTION_KEY_ARN inside the running container.
#   3. An encrypt/decrypt round trip under (2).
#
# (1) and (2) are not the same fact. tools/node/deploy-service.sh reads
# Parameter Store ONCE, at deploy time, and materialises it into the
# container's environment. Repointing the parameter therefore changes nothing
# about a process already running: the service keeps the ARN it was started
# with until it is redeployed. A check that reads only the parameter would
# have called the cutover done while every live service still called the old
# account's key.
#
# Nothing here writes: kms:Encrypt and kms:Decrypt are data-plane calls that
# leave no account state behind, and no parameter, key or container is
# modified.

readonly PROBE_PLAINTEXT="oxagen-ingestion-key-probe"

# kms_arn_parts ARN
#
# Echoes "<account> <region>" for a KMS key ARN, or fails. Split out because
# the whole verdict below turns on the account this ARN names, and a parsing
# bug there would report the old account as the new one.
kms_arn_parts() {
  local arn=$1 scheme partition service region account resource

  IFS=: read -r scheme partition service region account resource <<<"$arn"

  if [[ $scheme != "arn" || $partition != "aws" || $service != "kms" ]]; then
    echo "kms_arn_parts: not a KMS ARN: $arn" >&2
    return 1
  fi
  if [[ -z $region || -z $account || $resource != key/* ]]; then
    echo "kms_arn_parts: malformed KMS key ARN: $arn" >&2
    return 1
  fi

  printf '%s %s\n' "$account" "$region"
}

# redact_arn ARN
#
# The account and region are the answer; the key id is not, and this output
# gets pasted into issues. Keeps enough of the id to tell two keys apart.
redact_arn() {
  local arn=$1
  printf '%s\n' "$arn" | sed -E 's#(key/[0-9a-f]{8})[0-9a-f-]*#\1…#'
}

# probe_verdict PARAM_ARN RUNNING_ARN EXPECTED_ACCOUNT
#
# Classifies the two readings. Returns 0 when production encrypts with a key
# in the expected account and the running process agrees with the parameter;
# non-zero otherwise, with the distinction on stderr because the three
# failures need three different actions.
probe_verdict() {
  local param_arn=$1 running_arn=$2 expected_account=$3
  local param_parts running_parts param_account running_account running_region

  # Assigned on their own lines, not as `read ... <<<"$(kms_arn_parts ...)"`.
  # A here-string built from a failed command substitution is still one empty
  # line, so `read` succeeds, the accounts come out empty, and an unparseable
  # ARN compares equal to nothing and falls through to the success return —
  # the check reporting a pass on a reading it could not make.
  param_parts=$(kms_arn_parts "$param_arn") || return 3
  running_parts=$(kms_arn_parts "$running_arn") || return 3

  read -r param_account _ <<<"$param_parts"
  read -r running_account running_region <<<"$running_parts"

  if [[ $running_account != "$expected_account" ]]; then
    echo "FAIL: the running service encrypts with a key in $running_account ($running_region)," >&2
    echo "FAIL: not $expected_account. This is the cross-account dependency #2680 is about." >&2
    if [[ $param_account == "$expected_account" ]]; then
      echo "FAIL: Parameter Store already names $expected_account, so the Terraform" >&2
      echo "FAIL: has landed and the fix is a REDEPLOY of this service — the ARN is" >&2
      echo "FAIL: read once at deploy time and this process still holds the old one." >&2
    fi
    return 1
  fi

  if [[ $param_arn != "$running_arn" ]]; then
    echo "WARN: Parameter Store and the running service name different keys." >&2
    echo "WARN:   parameter: $(redact_arn "$param_arn")" >&2
    echo "WARN:   running:   $(redact_arn "$running_arn")" >&2
    echo "WARN: Both are in $expected_account, so nothing is reaching the old" >&2
    echo "WARN: account, but this service is a deploy behind the parameter." >&2
    return 2
  fi

  return 0
}

# render_ingestion_probe REGION PARAM_PREFIX CONTAINER
#
# The script that runs on the node. Rendered here and read by the test,
# because the only machine that can run it is the one whose state is in
# question.
render_ingestion_probe() {
  if [[ $# -ne 3 ]]; then
    echo "render_ingestion_probe: expected 3 arguments, got $#" >&2
    return 2
  fi

  local region=$1 prefix=$2 container=$3 arg name
  local -a names=(region prefix container)
  local i=0
  for arg in "$region" "$prefix" "$container"; do
    name=${names[$i]}
    i=$((i + 1))
    [[ -n $arg ]] || { echo "render_ingestion_probe: $name is empty" >&2; return 2; }
  done

  local rendered
  rendered=$(
    cat <<'REMOTE'
set -euo pipefail

# Identity and answer in one run, so nobody has to trust which account this
# was read from. Reading /oxagen/production/* with a contributor's credentials
# reads a DIFFERENT store with the same path — that is how this dependency
# stayed invisible for two weeks (infra/legacy/README.md).
echo "=== identity for THIS read ==="
aws sts get-caller-identity --query '[Account,Arn]' --output text

echo "=== parameter store ==="
PROVIDER=$(aws ssm get-parameter --region __REGION__ \
  --name __PREFIX__/INGESTION_CRYPTO_PROVIDER --with-decryption \
  --query Parameter.Value --output text)
PARAM_ARN=$(aws ssm get-parameter --region __REGION__ \
  --name __PREFIX__/AWS_KMS_INGESTION_KEY_ARN --with-decryption \
  --query Parameter.Value --output text)
echo "INGESTION_CRYPTO_PROVIDER = $PROVIDER"
echo "AWS_KMS_INGESTION_KEY_ARN = $PARAM_ARN"

# The value the process is actually using. -e KEY (no value) at docker run
# means the value is resolved from the deploy shell's environment, so it lands
# in the container's config rather than in anyone's argv.
echo "=== the running container ==="
RUNNING_ARN=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' __CONTAINER__ \
  | sed -n 's/^AWS_KMS_INGESTION_KEY_ARN=//p' | head -1)
if [ -z "$RUNNING_ARN" ]; then
  echo "error: __CONTAINER__ has no AWS_KMS_INGESTION_KEY_ARN in its environment" >&2
  echo "error: either it is not running, or it was deployed before the key existed" >&2
  exit 1
fi
echo "container AWS_KMS_INGESTION_KEY_ARN = $RUNNING_ARN"

KEY_REGION=$(printf '%s' "$RUNNING_ARN" | cut -d: -f4)

# A round trip under the key the service holds, not under the parameter's.
# Encrypt and decrypt are data-plane calls: nothing in the account changes.
echo "=== round trip under the running key ==="
PROBE=$(mktemp) && printf '%s' '__PROBE__' > "$PROBE"
CIPHER=$(mktemp)
trap 'rm -f "$PROBE" "$CIPHER"' EXIT

aws kms encrypt --region "$KEY_REGION" --key-id "$RUNNING_ARN" \
  --plaintext "fileb://$PROBE" --query CiphertextBlob --output text \
  | base64 -d > "$CIPHER"

ROUNDTRIP=$(aws kms decrypt --region "$KEY_REGION" \
  --ciphertext-blob "fileb://$CIPHER" --query Plaintext --output text | base64 -d)

if [ "$ROUNDTRIP" != '__PROBE__' ]; then
  echo "error: the key encrypted but did not decrypt to the same bytes" >&2
  exit 1
fi
echo "round trip OK under $RUNNING_ARN"
REMOTE
  )

  rendered=${rendered//__REGION__/$region}
  rendered=${rendered//__PREFIX__/$prefix}
  rendered=${rendered//__CONTAINER__/$container}
  rendered=${rendered//__PROBE__/$PROBE_PLAINTEXT}

  if [[ $rendered == *__* ]]; then
    echo "render_ingestion_probe: unsubstituted placeholder in rendered script" >&2
    printf '%s\n' "$rendered" | grep -n '__' >&2
    return 1
  fi

  printf '%s\n' "$rendered"
}

# ---------------------------------------------------------------------------
# Definitions above, execution below. Sourcing stops here so the test can
# render and read the remote script without an account to run it in — the
# same guard tools/run-db-migrations.sh uses, for the same reason.
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0
fi

set -euo pipefail

SERVICE=${1:-api}
REGION=${REGION:-us-east-1}
PREFIX=${PREFIX:-/oxagen/production}
EXPECTED_ACCOUNT=${EXPECTED_ACCOUNT:-916294258235}
CONTAINER=oxagen-$SERVICE

if [[ -z ${INSTANCE:-} ]]; then
  INSTANCE=$(aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Name,Values=${NODE_NAME:-oxagen-app}" \
              "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].InstanceId' --output text)
  if [[ $(printf '%s' "$INSTANCE" | wc -w) -ne 1 ]]; then
    echo "error: expected one running instance tagged Name=${NODE_NAME:-oxagen-app}, got: $INSTANCE" >&2
    echo "error: the node lives in $EXPECTED_ACCOUNT — check which account these credentials reach." >&2
    exit 1
  fi
fi

REMOTE_FILE=$(mktemp "${TMPDIR:-/tmp}/probe-remote-XXXXXX")
PARAMS_FILE=$(mktemp "${TMPDIR:-/tmp}/probe-params-XXXXXX")
trap 'rm -f "$REMOTE_FILE" "$PARAMS_FILE"' EXIT

render_ingestion_probe "$REGION" "$PREFIX" "$CONTAINER" > "$REMOTE_FILE"

python3 - "$REMOTE_FILE" "$PARAMS_FILE" <<'PY'
import json, sys
json.dump({"commands": open(sys.argv[1]).read().splitlines()}, open(sys.argv[2], "w"))
PY

CMD=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript --parameters "file://$PARAMS_FILE" \
  --query 'Command.CommandId' --output text)
echo "==> ssm command $CMD on $INSTANCE"

st=Pending
for _ in $(seq 1 30); do
  st=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" \
    --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  [[ $st == InProgress || $st == Pending ]] || break
  sleep 5
done

OUT=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" \
  --instance-id "$INSTANCE" --query StandardOutputContent --output text 2>/dev/null || true)
printf '%s\n' "$OUT"

if [[ $st != "Success" ]]; then
  echo "--- stderr ---" >&2
  aws ssm get-command-invocation --region "$REGION" --command-id "$CMD" \
    --instance-id "$INSTANCE" --query StandardErrorContent --output text 2>/dev/null >&2 || true
  echo "==> FAILED: the probe finished as $st" >&2
  exit 1
fi

PARAM_ARN=$(printf '%s\n' "$OUT" | sed -n 's/^AWS_KMS_INGESTION_KEY_ARN = //p' | head -1)
RUNNING_ARN=$(printf '%s\n' "$OUT" | sed -n 's/^container AWS_KMS_INGESTION_KEY_ARN = //p' | head -1)

if [[ -z $PARAM_ARN || -z $RUNNING_ARN ]]; then
  echo "==> could not read both ARNs out of the probe output" >&2
  exit 1
fi

echo
echo "=== verdict for $SERVICE ==="
if probe_verdict "$PARAM_ARN" "$RUNNING_ARN" "$EXPECTED_ACCOUNT"; then
  echo "PASS: $SERVICE encrypts with $(redact_arn "$RUNNING_ARN")"
  echo "PASS: that key is in $EXPECTED_ACCOUNT and completed an encrypt/decrypt round trip."
  exit 0
fi
exit $?
