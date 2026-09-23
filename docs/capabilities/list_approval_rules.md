# list_approval_rules

**Domain:** approval_rule
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Sensitivity:** medium
**Metering:** none (`noBillingGate`, a console read)
**App:** Tools › Policy at `/{org}/{ws}/tools/policy`: the auto-approval rules table. An org Owner, Admin or Compliance sees it.

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
`createdBy` (`usr_…`), `createdAt`, and `authoredConsequences` — the effective
consequence tags the rule's tools carried when it was last written, which the
evaluation compares a call's tool against so a tool classified afterwards
cannot be auto-approved under a rule nobody was accountable for.

Beside each rule, over `windowDays` (30): `hits30d`, the calls it released
with no person, and `skipped30d`, the calls that reached a person's queue with
this rule recorded beside them. Both are counted from
`agent.approval_requests`, so they are the record rather than a rollup of it,
and both count only calls that produced an approval row. A decision rule's
`require_approval` verdict that no auto-approval rule released writes no such
row — the gate refuses the call rather than queueing it — so it appears in
neither figure; what is counted is every call a mandate parked.

## Readers

An org Owner, Admin or Compliance.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | No signed-in user on the request. |
| `forbidden` | `org_role_required` | The caller holds none of the three roles. |

## SPEC references

- §6.9 part 2 (auto-approval), §6.12 (policy is deterministic); ADR-070


## Tool changes and disabled rules

Tool classification and publication recheck matching enabled approval rules in
the same transaction as the tool write (ADR-119). A rule whose recorded author
no longer has authority is disabled. A changed measure path, type, unit, or
scale used by the rule, or a newly matching tool, requires explicit review.
The tool change itself is not refused because an existing rule fails that check.

`disabledReason` carries `code` (`classification_changed`, `measure_changed`, or
`tool_scope_changed`), `tool` (`slug@version`), `at`, and `detail`. API and MCP
reads return it, and Tools shows the reason. Switching off preserves it. Saving
or switching on reruns the authoring checks and clears it. The security event
`approval_rule.invalidated` names the rule, tool, actor, and before/after facts.
