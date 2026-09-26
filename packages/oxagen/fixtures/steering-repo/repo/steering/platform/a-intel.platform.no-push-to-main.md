---
schema: steering-record/v1
lineage: a-intel.platform.no-push-to-main
label: Never push to main
description: Work reaches main only through a pull request.
kind: constraint
effect: forbid
force: must
scope: workspace
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5V0AB
id: rec_a_intel_platform_no_push_to_main_a897828bd1ba
hash: sha256:b48e18ed2a9acd10853dad32bd1286166424a806de783cba9115649ffcd7ecc0
---

Do not push to `main` or force-push any shared branch. Open a pull request
from a branch named for the work.
