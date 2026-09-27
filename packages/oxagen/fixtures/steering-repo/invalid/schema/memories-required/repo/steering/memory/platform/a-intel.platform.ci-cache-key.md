---
schema: steering-record/v1
lineage: a-intel.platform.ci-cache-key
label: CI cache key includes the lockfile
description: A dependency change without a lockfile update breaks CI.
kind: memory
force: info
scope: repository
repos:
  - github.com/a-intel/platform
applies_to:
  - "pnpm-lock.yaml"
  - ".github/workflows/**"
load: match
status: active
origin: inferred
provenance:
  source: run
  uri: frame:run_01K5QK7D/88
---

The CI cache key hashes `pnpm-lock.yaml`. A run that changes dependencies
without updating the lockfile restores a stale cache and fails typecheck.
