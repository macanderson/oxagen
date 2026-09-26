---
schema: steering-record/v1
lineage: a-intel.platform.no-push-to-main
label: Protect main
description: Only pull requests reach main.
kind: constraint
effect: forbid
force: must
scope: workspace
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5X4BA
---

Do not push commits straight to `main`.
