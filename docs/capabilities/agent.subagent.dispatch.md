# agent.subagent.dispatch

**Domain:** agent
**Mode:** async
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Fan out a set of tasks to multiple subagents running in parallel. Creates a
dispatch fanout record and queues each task as an Inngest job. Returns a
dispatchId the caller can poll via agent.subagent.aggregate.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| parentMessageId | string | Message ID that triggered the fanout |
| tasks | array of objects | Subtasks with capability name and input (1-100 items). Budgets (Phase 2 §4): nesting depth ≤ 3, and ≤ 250 total descendant tasks per root fanout tree — a dispatch that would exceed the descendant cap is rejected before any row is created. |
| maxParallel | number | Maximum concurrent tasks (default 5, max 50) |
| timeoutSeconds | number? | Per-task timeout in seconds (optional, 1-3600) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| dispatchId | string | Fanout record ID — pass to agent.subagent.aggregate |
| totalTasks | number | Total number of tasks dispatched |
| status | enum | Dispatch status: "pending" or "running" |

## Side effects

Creates dispatch record in Postgres. Queues Inngest jobs for each task (async
execution). ClickHouse observes dispatch event.

## Errors

None explicitly defined in the contract.
