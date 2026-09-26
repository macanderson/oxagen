---
schema: steering-record/v1
lineage: a-intel.platform.production-branch
label: Production deploys from main
description: Which branch deploys to production, and when.
kind: fact
force: info
scope: repository
repos:
  - github.com/a-intel/platform
load: relevant
status: active
origin: user
provenance:
  source: import
  uri: oxagen:import/claude-md/platform
id: rec_a_intel_platform_production_branch_abc5fd6cbed2
hash: sha256:65674887710b3a03b16fc591502b2ff1d5f33fa009fff848c56ce0ddd3462216
---

`main` deploys to production on every merge, through the `deploy` workflow.
Staging deploys from `staging` on the same schedule.
