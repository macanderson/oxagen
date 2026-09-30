#!/usr/bin/env bash
# Bootstrap and operator entry point. Executable helpers come from one approved release.
set -euo pipefail
source /opt/oxagen/bin/node.env
exec python3 /opt/oxagen/bin/deploy-dispatch.py deploy \
  --service "${1:?service is required}" --digest current \
  --bucket "$DEPLOY_BUCKET" --region "$REGION"
