---
schema: steering-record/v1
lineage: a-intel.domain.refund
label: Refund
description: What a refund is at a-intel, its states, and the tools that change it.
kind: fact
force: info
scope: workspace
tools:
  - billing__*
load: relevant
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5Y1QA
id: rec_a_intel_domain_refund_8b4bb2132013
hash: sha256:1d9081c58113ac48c47605f4ce0bf9bc7a59cb417bffa3e6494c5e76ef7d9e64
---

A refund returns money against one captured charge. Amounts are integers in
cents.

States: `pending`, `succeeded`, `failed`, `canceled`. Only `pending` can be
canceled, with `@tool:billing__cancel_refund`.

A refund belongs to one charge (`billing__get_charge`) and one customer.
