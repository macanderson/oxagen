# set_approval_rule_enabled

**Domain:** approval_rule
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Sensitivity:** high
**Metering:** none (`noBillingGate`, a settings write)
**App:** Tools › Auto-approvals › Switch on or Switch off on a row, and Switch off instead in the delete dialog.

## Intent

Switch one auto-approval rule on or off. The one write on this page that is
not a rewrite of the whole set: an operator stopping a rule mid-incident
should not have to send every other rule back with it.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `ruleId` | `string` | The rule's slug. |
| `enabled` | `boolean` | The state to put it in. |

## Output

The whole set with the rule in its new state, as `list_approval_rules`
returns it.

## Writers

An org Owner or Admin. Switching a rule **on** re-runs the guards
`set_approval_rules` applied when it was written — the declared tools it
matches, their measures, and the org role accountable for their consequences
— because a tool's classification can change while a rule is off. Switching
it off runs none of them: it can only send more calls to a person.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | No signed-in user on the request. |
| `forbidden` | `org_role_required` | The caller may not write rules, or may not switch this one on. |
| `conflict` | `no_tool_matches` | Switching on: a tool pattern now matches no declared tool. |
| `conflict` | `measure_not_declared` | Switching on: a condition names a measure a matched tool no longer declares. |
| `not_found` | `approval_rule_not_found` | No rule by that id in this workspace. |

## SPEC references

- §6.9 part 2; ADR-070
