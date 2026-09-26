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
id: rec_a_intel_platform_ci_cache_key_6a3ca3b476bf
hash: sha256:1b03ba4276a68736bf4c47f0a83a39b414f2effd27760d977ba99e9ecaccf243
---

The CI cache key hashes `pnpm-lock.yaml`. A run that changes dependencies
without updating the lockfile restores a stale cache and fails typecheck.
