---
schema: steering-record/v1
lineage: a-intel.platform.push-to-main
label: Push to main
description: A constraint that requires what another forbids.
kind: constraint
effect: require
force: must
scope: workspace
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5X6DA
---

Do not push to `main` or force-push any shared branch. Open a pull request
from a branch named for the work.
