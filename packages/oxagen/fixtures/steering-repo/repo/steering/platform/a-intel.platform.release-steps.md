---
schema: steering-record/v1
lineage: a-intel.platform.release-steps
label: Release steps
description: How to cut a release of the platform service.
kind: procedure
force: should
scope: repository
repos:
  - github.com/a-intel/platform
load: relevant
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5W1CE
id: rec_a_intel_platform_release_steps_926430fc76d1
hash: sha256:bc5515587f38f4800c8cd55546933c34df5ac6575571836c0d87a339327d7fd0
---

1. Merge every pull request labeled for the release.
2. Run `pnpm changeset version` and commit the changelog.
3. Tag the commit `vX.Y.Z` and push the tag.
4. Call `github__create_release` with the changelog section as the body.
