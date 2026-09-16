# set_approval_rules

**Domain:** approval_rule
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Sensitivity:** high
**Metering:** none (`noBillingGate`, a settings write)

## Intent

Write the workspace's auto-approval rules. Create and edit are the same
write: the caller sends the whole set and it replaces the stored clause
atomically, so two rules can never disagree about which one a call matched
first. An agent's call waits for a person (`agent.requiresApproval`).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `rules` | `ApprovalRuleBody[]` | Up to 256. An empty array clears the clause. |

A rule body is the rule shape without `createdBy`, `createdAt` and
`authoredConsequences`, which the handler records. Every condition defaults
off, so a rule names only what it asks for: `enabled` true, `maxMeasures` and
`allowTargets` empty, `standingWindowMs` and `businessHours` null.

`authoredConsequences` is the effective consequence tags the rule's tools
carried at this write — the union of the declared column and the classified
jsonb. It is the handler's to set and an author cannot supply it. The
evaluation compares a call's tool against it, so a tool classified AFTER a
rule was authored stops that rule releasing calls (`consequences_changed`)
until it is saved again, which re-runs the role check below. A consequence
REMOVED from a tool leaves the rule qualifying: losing one cannot make the
rule more dangerous than it was approved to be.

## Output

The same page `list_approval_rules` returns, so the caller needs no second
read.

## Writers

An org Owner or Admin, who must also hold the role the workspace names for
every consequence the rules' tools carry.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | No signed-in user on the request. |
| `forbidden` | `org_role_required` | The caller may not write rules, or may not write one over these consequences — spec §6.9 part 2's rule that a rule cannot be saved that would widen an agent past its operator's grants. |
| `forbidden` | `no_role_covers_all_tags` | No single org role is accountable for every consequence the matched tools carry together. |
| `conflict` | `no_tool_matches` | A tool pattern matches no declared, enabled tool in this workspace. |
| `conflict` | `measure_not_declared` | A condition names a measure a matched tool does not declare. |
| `not_found` | `workspace_not_found` | The workspace is not readable in this scope. |

## SPEC references

- §6.9 part 2, App. E; ADR-070
