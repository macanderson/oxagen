---
schema: steering-record/v1
lineage: a-intel.billing.refund-reasons
label: Refund reasons
description: Every refund names its reason.
kind: business-rule
force: "must!"
scope: workspace
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5X3AA
---

Give every refund a reason: duplicate, fraudulent, or requested_by_customer.
