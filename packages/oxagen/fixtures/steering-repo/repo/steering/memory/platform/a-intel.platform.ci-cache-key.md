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
  memories:
    - agent: a-intel.core.release-bot
      run: run_01K5QK7D
      statement: The CI cache key hashes pnpm-lock.yaml. Update the lockfile with any dependency change, or CI restores a stale cache and typecheck fails.
      evidence:
        - frame:run_01K5QK7D/88
    - agent: null
      run: null
      statement: CI restored a stale pnpm cache after a dependency bump left pnpm-lock.yaml unchanged.
      evidence:
        - github.com/a-intel/platform/pull/412
id: rec_a_intel_platform_ci_cache_key_873516889942
hash: sha256:cd6685d7f6a65702d04489d6b7b6647116c8b7787b5022746f2802fc5f88edff
---

The CI cache key hashes `pnpm-lock.yaml`. A run that changes dependencies
without updating the lockfile restores a stale cache and fails typecheck.
