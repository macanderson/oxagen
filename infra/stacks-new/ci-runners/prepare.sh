#!/usr/bin/env bash
# Downloads the runner module's Lambda packages before `tofu plan` and
# `tofu apply`. infra.yml runs a stack's prepare.sh when it has one.
#
# The packages are build outputs of the module's release, so they are not
# committed. Each one is checked against the SHA-256 in lambdas.sha256, which
# was computed from the v7.11.0 release assets. A package that does not match
# stops the plan before Terraform reads it.
#
# Bump all three together with the module ref in runners.tf, and copy the new
# release's start-runner.sh into image/vendor/ in the same change.
set -euo pipefail

cd "$(dirname "$0")"
version=v7.11.0
base="https://github.com/github-aws-runners/terraform-aws-github-runner/releases/download/$version"

mkdir -p .lambdas
while read -r sum name; do
  [ -n "$name" ] || continue
  if [ ! -f ".lambdas/$name" ] || ! echo "$sum  .lambdas/$name" | sha256sum -c --status - 2>/dev/null; then
    curl -fsSL --retry 5 --retry-delay 3 -o ".lambdas/$name" "$base/$name"
  fi
  echo "$sum  .lambdas/$name" | sha256sum -c -
done < lambdas.sha256
