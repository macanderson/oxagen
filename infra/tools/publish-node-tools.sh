#!/usr/bin/env bash
# Run with infrastructure authority. Application deploy roles cannot publish these keys.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUCKET=${BUCKET:?Set the deployment bucket}
REGION=${REGION:-us-east-1}
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
digest=$(python3 "$HERE/node/deploy-dispatch.py" publish-files --output "$staging")
dispatcher_hash=$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$staging/deploy-dispatch.py")
# Content-addressed payloads are verified before installation or execution.
aws s3 cp "$staging/deploy-dispatch.py" "s3://$BUCKET/_node-tools/dispatchers/$dispatcher_hash.py" --region "$REGION" --only-show-errors
aws s3 cp "$staging/bundle.json" "s3://$BUCKET/_node-tools/releases/$digest.json" --region "$REGION" --only-show-errors
aws s3 cp "$staging/deploy-dispatch.py" "s3://$BUCKET/_bin/deploy-dispatch.py" --region "$REGION" --only-show-errors
# Publish the bootstrap entry point after its dispatcher and approved bundle exist.
aws s3 cp "$staging/deploy-launcher.sh" "s3://$BUCKET/_bin/deploy-service.sh" --region "$REGION" --only-show-errors
aws s3 cp "$staging/current.json" "s3://$BUCKET/_node-tools/current.json" --region "$REGION" --only-show-errors
printf 'Published node toolchain %s\n' "$digest"
