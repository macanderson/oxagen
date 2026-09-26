---
schema: steering-record/v1
lineage: a-intel.billing.refunds-over-100
label: Refunds over $100
description: Refunds above $100 wait for a person's approval in the run.
kind: business-rule
force: must
scope: repository
repos:
  - github.com/a-intel/billing-service
tools:
  - billing__create_refund
status: active
origin: user
provenance:
  source: proposal
  uri: oxagen:proposal/prp_01K5RW2P
id: rec_a_intel_billing_refunds_over_100_51b0dbd761ba
hash: sha256:af47e0091c4ed9610c2ba20eae9e8871608a5ed031fc7cb0685fa766a336689e
---

Refunds over $100 need a person's approval before you call
`billing__create_refund`. Ask in the run and wait. Do not split one refund
into smaller refunds to stay under the limit.
