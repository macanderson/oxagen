#!/usr/bin/env bash
#
# Holds the ingestion-key witness to the distinction it exists to draw.
#
# The check that looks obvious — read /oxagen/production/AWS_KMS_INGESTION_KEY_ARN
# and see whether it names the current account — is the one that would have
# reported the cutover complete while every running service still called the
# retired account's key. deploy-service.sh reads Parameter Store once, at
# deploy time, so the parameter and the process are two different facts. Most
# of what follows is that case.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOLS=$(cd "$HERE/.." && pwd)

# shellcheck source=infra/tools/verify-ingestion-key.sh
source "$TOOLS/verify-ingestion-key.sh"

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

NEW=arn:aws:kms:us-east-1:916294258235:key/c332275c-6ba0-46f6-9578-f221646c3f9a
OLD=arn:aws:kms:us-east-2:578673726240:key/11111111-2222-3333-4444-555555555555
NEW2=arn:aws:kms:us-east-1:916294258235:key/99999999-8888-7777-6666-555555555555

# --- reading an ARN --------------------------------------------------------
#
# The verdict turns entirely on the account this pulls out, so a parsing bug
# here would report the retired account as the current one.

[[ $(kms_arn_parts "$NEW") == "916294258235 us-east-1" ]] && pass \
  || fail "the new account's ARN parses to its account and region"
[[ $(kms_arn_parts "$OLD") == "578673726240 us-east-2" ]] && pass \
  || fail "the old account's ARN parses to its account and region"

for bad in "" "not-an-arn" "arn:aws:s3:::bucket" \
           "arn:aws:kms:us-east-1:916294258235:alias/oxagen-app/ingestion" \
           "arn:aws:kms::916294258235:key/abc"; do
  if kms_arn_parts "$bad" >/dev/null 2>&1; then
    fail "kms_arn_parts should refuse: '$bad'"
  else
    pass
  fi
done

# --- the verdict -----------------------------------------------------------

probe_verdict "$NEW" "$NEW" 916294258235 2>/dev/null && pass \
  || fail "parameter and process both on the current account's key is a pass"

# The whole point. The Terraform has landed, the parameter is right, and the
# service is still encrypting with the retired account's key because nobody
# has redeployed it. A parameter-only check calls this done.
probe_verdict "$NEW" "$OLD" 916294258235 2>/dev/null \
  && fail "a service still holding the old account's key must not pass" || pass

STALE=$(probe_verdict "$NEW" "$OLD" 916294258235 2>&1)
contains "$STALE" "578673726240" "stale process: names the account it is still calling"
contains "$STALE" "REDEPLOY" "stale process: names the action that fixes it"
contains "$STALE" "read once at deploy time" "stale process: says why the parameter looks right"

# Both readings on the old account: the Terraform has not landed either, so
# redeploying would change nothing and the advice must not say to.
BOTH_OLD=$(probe_verdict "$OLD" "$OLD" 916294258235 2>&1)
lacks "$BOTH_OLD" "REDEPLOY" "nothing landed yet: does not advise a redeploy"
contains "$BOTH_OLD" "#2680" "nothing landed yet: names the issue"

# Two different keys, both in the right account. Nothing reaches the retired
# account, so this is not the failure above — but the service is a deploy
# behind and that should be visible rather than silently green.
probe_verdict "$NEW" "$NEW2" 916294258235 2>/dev/null
[[ $? == 2 ]] && pass || fail "a deploy-behind service in the right account is its own outcome"
DRIFT=$(probe_verdict "$NEW" "$NEW2" 916294258235 2>&1)
contains "$DRIFT" "a deploy behind" "deploy behind: says what it is"
lacks "$DRIFT" "FAIL" "deploy behind: is not the cross-account failure"

# A malformed reading is neither a pass nor a quiet failure.
probe_verdict "$NEW" "garbage" 916294258235 2>/dev/null
[[ $? == 3 ]] && pass || fail "an unreadable ARN is its own outcome, not a pass"

# --- what gets pasted into an issue ----------------------------------------

REDACTED=$(redact_arn "$NEW")
contains "$REDACTED" "916294258235" "redaction keeps the account, which is the answer"
contains "$REDACTED" "us-east-1" "redaction keeps the region"
contains "$REDACTED" "key/c332275c" "redaction keeps enough id to tell two keys apart"
lacks "$REDACTED" "f221646c3f9a" "redaction drops the rest of the key id"

# --- the script that runs on the node --------------------------------------

PROBE=$(render_ingestion_probe "us-east-1" "/oxagen/production" "oxagen-api")

lacks "$PROBE" "__" "no placeholder survives"
contains "$PROBE" "aws sts get-caller-identity" "states which account it read from"
contains "$PROBE" "/oxagen/production/AWS_KMS_INGESTION_KEY_ARN" "reads the parameter"
contains "$PROBE" "--with-decryption" "decrypts the SecureString rather than printing ciphertext"
contains "$PROBE" "docker inspect" "reads the running container's own value"
contains "$PROBE" "oxagen-api" "names the container asked for"
contains "$PROBE" "kms encrypt" "encrypts"
contains "$PROBE" "kms decrypt" "decrypts"

# The round trip must use the key the PROCESS holds. Using the parameter's
# would prove the new key works while the service still called the old one.
contains "$PROBE" '--key-id "$RUNNING_ARN"' "the round trip uses the running key, not the parameter"

# Nothing here may change the account.
for forbidden in "kms:ScheduleKeyDeletion" "delete-" "put-parameter" "create-key" "docker rm" "docker stop"; do
  lacks "$PROBE" "$forbidden" "the probe does not mutate: $forbidden"
done

if render_ingestion_probe "" "/oxagen/production" "oxagen-api" >/dev/null 2>&1; then
  fail "an empty region should be refused"
else
  pass
fi
if render_ingestion_probe "us-east-1" "/oxagen/production" >/dev/null 2>&1; then
  fail "a wrong argument count should be refused"
else
  pass
fi

# --- result ---------------------------------------------------------------

if [[ $FAILED -gt 0 ]]; then
  echo "verify-ingestion-key: $FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "verify-ingestion-key: $CASES assertions passed"
