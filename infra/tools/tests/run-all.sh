#!/usr/bin/env bash
#
# Every test under infra/tools/tests, in one command.
#
# These scripts reach production: one applies Atlas migrations to Aurora, the
# other reads which KMS key the platform encrypts with. Neither can be
# exercised by running it — that needs the very account whose state is in
# question — so what they render and how they classify a result is the only
# thing a test can hold, and it has to run somewhere.
#
# CI reaches this through `check:db-migrate-script` in the root package.json,
# which .github/workflows/pipeline.yml already calls in its `checks` job. That
# name is now narrower than what it runs; renaming it means editing the
# workflow too, which is left for whoever is next in that file.
#
# A new *.test.sh here is picked up with no edit to this file or to CI.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

failed=0
ran=0

for test in "$HERE"/*.test.sh; do
  [[ -e $test ]] || continue
  ran=$((ran + 1))
  echo "--- $(basename "$test")"
  if ! bash "$test"; then
    failed=$((failed + 1))
  fi
done

# Zero test files is a failure, not a pass. A rename or a bad glob would
# otherwise leave this reporting success while checking nothing.
if [[ $ran -eq 0 ]]; then
  echo "run-all: no *.test.sh found in $HERE" >&2
  exit 1
fi

if [[ $failed -gt 0 ]]; then
  echo "run-all: $failed of $ran test files failed" >&2
  exit 1
fi
echo "run-all: $ran test files passed"
