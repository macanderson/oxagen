# agent.plan.get

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Fetch a single execution plan by id, including its status, tasks, and approval
state. Read-only; RLS scopes the lookup to the caller's org + workspace.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| planId | string | The plan's public id (apl_…) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| planId | string | Plan public id |
| status | string | draft \| awaiting_approval \| approved \| denied \| amended |
| goals | array of strings | Goals |
| constraints | array of strings | Constraints |
| tasks | array | Task/step payloads |
| approvalRequired | boolean | Whether approval gates execution |
| approvedAt | string? | ISO 8601 resolution timestamp (null until approved) |
| approvedByUserId | string? | Who resolved the plan (null until resolved) |
| taskCount | number | Number of tasks |
| createdAt | string | ISO 8601 timestamp |

## Side effects

None (read-only).

## Errors

Throws "Plan not found" when the id does not resolve within the caller's tenant.
