# agent.plan.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List a workspace's execution plans, newest first, optionally filtered by status.
Cursor-paginated (keyset on createdAt). Read-only.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| status | string? | Filter to plans in this status |
| limit | number | Max plans to return (1-100, default 20) |
| cursor | string? | Pass the previous page's nextCursor (an ISO createdAt) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| plans | array of objects | Per-plan summary (planId, status, goals, approvalRequired, approvedAt, taskCount, createdAt) |
| nextCursor | string? | Cursor for the next page, or null when exhausted |

## Side effects

None (read-only).

## Errors

None explicitly defined in the contract.
