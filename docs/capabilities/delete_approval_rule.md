# delete_approval_rule

**Domain:** approval_rule
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Sensitivity:** high
**Metering:** none (`noBillingGate`, a settings write)

## Intent

Take one auto-approval rule out of the workspace's rule set. The Tools page
offers "switch off instead" beside it, because a rule that is off keeps its
id and so keeps its counters and every receipt that cites it readable.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `ruleId` | `string` | The rule's slug. |

## Output

The remaining rules, as `list_approval_rules` returns them.

## Writers

An org Owner or Admin. Removing a rule can only send more calls to a person,
so no consequence-role check rides with it.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | No signed-in user on the request. |
| `forbidden` | `org_role_required` | The caller may not write rules. |
| `not_found` | `approval_rule_not_found` | No rule by that id in this workspace. |

## SPEC references

- §6.9 part 2; ADR-069
