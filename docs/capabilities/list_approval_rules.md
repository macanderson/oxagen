# list_approval_rules

**Domain:** approval_rule
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Sensitivity:** medium
**Metering:** none (`noBillingGate`, a console read)

## Intent

The workspace's auto-approval rules — the conditions under which a call a
policy sent to a person may skip them — with what each one has done in the
last 30 days. The read behind Tools › Auto-approvals.

## Input

Takes no argument. The rule set is a workspace's, and it is small enough to
return whole.

## Output

`{ items: ApprovalRule[], windowDays: number }`.

A rule (spec §6.9 part 2): `id` (the slug a receipt cites as
`policy:<id>`), `name`, `tools` (globs over a declared tool's `slug@version`
or its bare slug), `enabled`, `maxMeasures` (measure → an inclusive integer
ceiling, micros for a currency), `allowTargets` (measure → the globs its
target must match), `standingWindowMs` (the window in which a person's
approval of the same call digest re-applies, or null), `businessHours`
(`{ timezone, days, start, end }` local to the rule's own zone, or null),
`createdBy` (`usr_…`) and `createdAt`.

Beside each rule, over `windowDays` (30): `hits30d`, the calls it released
with no person, and `skipped30d`, the calls it was read against and did not
release. Both are counted from `agent.approval_requests`, so they are the
record rather than a rollup of it.

## Readers

An org Owner, Admin or Compliance.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | No signed-in user on the request. |
| `forbidden` | `org_role_required` | The caller holds none of the three roles. |

## SPEC references

- §6.9 part 2 (auto-approval), §6.12 (policy is deterministic); ADR-069
