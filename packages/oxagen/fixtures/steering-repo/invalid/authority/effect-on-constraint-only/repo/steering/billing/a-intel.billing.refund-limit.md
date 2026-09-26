---
schema: steering-record/v1
lineage: a-intel.billing.refund-limit
label: Refund limit
description: The largest refund an agent sends without approval.
kind: business-rule
effect: require
force: must
scope: workspace
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5X7EA
---

Ask for approval before a refund over $500.
