# agent.subagent.aggregate

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Wait for all child runs in a subagent fanout to complete and return merged
results, conflict list, and execution timeline.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| fanoutId | string | Public ID of the subagent fanout to aggregate |
| timeoutMs | number | Max milliseconds to wait for all children (default 5min, max 30min) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| fanoutId | string | Fanout ID from input |
| status | enum | Aggregation status: "completed", "partial", "failed", "timed_out" |
| totalChildren | number | Total number of child runs in the fanout |
| completedChildren | number | Number of children that completed successfully |
| aggregatedData | object? | Merged output data from all successful runs (nullable) |
| conflicts | array of objects | Keys where two or more runs produced different values |
| timeline | array of objects | Execution timeline for each child run |
| firstError | string? | Error reason from the first failed child, or null |

## Side effects

Reads from Postgres/Inngest job store. No mutations. ClickHouse telemetry
events recorded for aggregation.

## Errors

None explicitly defined in the contract.
