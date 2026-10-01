#!/usr/bin/env bash
# Stores the CI runner scaler's GitHub App in Parameter Store, straight from
# GitHub's manifest conversion, so the private key never touches a file.
#
#   1. Open scripts/github-app-manifest.html in a browser and press the button.
#   2. On GitHub, press "Create GitHub App for oxageninc".
#   3. GitHub sends you to oxagen.sh with ?code=... in the address bar. Copy
#      the code (it expires in an hour) and run:
#
#        infra/stacks-new/ci-runners/scripts/store-github-app.sh <code>
#
# Needs `gh` signed in as an organization owner and AWS credentials for
# account 916294258235. It prints the App's id and the link to install it.
set -euo pipefail

code=${1:?usage: store-github-app.sh <code from the redirect address>}
region=us-east-1
prefix=/oxagen/ci-runners/github-app

resp=$(gh api -X POST "app-manifests/$code/conversions")
id=$(jq -r .id <<<"$resp")
slug=$(jq -r .slug <<<"$resp")
pem=$(jq -r .pem <<<"$resp")
secret=$(jq -r .webhook_secret <<<"$resp")
unset resp

if [ -z "$id" ] || [ "$id" = null ] || [ -z "$pem" ] || [ "$pem" = null ] || [ -z "$secret" ] || [ "$secret" = null ]; then
  echo "GitHub did not return an App id, key, and webhook secret. Create the App again and use the new code." >&2
  exit 1
fi

put() {
  aws ssm put-parameter --region "$region" --name "$1" --type SecureString --overwrite \
    --description "$2" --value "$3" >/dev/null
}

put "$prefix/id" "GitHub App id for the CI runner scaler ($slug)." "$id"
put "$prefix/key_base64" "GitHub App private key, base64, for the CI runner scaler ($slug)." \
  "$(printf '%s' "$pem" | base64 | tr -d '\n')"
put "$prefix/webhook_secret" "GitHub App webhook secret for the CI runner scaler ($slug)." "$secret"
unset pem secret

echo "Stored GitHub App $slug (id $id) under $prefix."
echo "Install it on the private repositories: https://github.com/apps/$slug/installations/new"
