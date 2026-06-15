# research.swarm.status

**Domain:** research
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Poll the status of a running research swarm. Returns task completion progress
and partial results. Delegates to agent.subagent.aggregate internally.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| swarmId | string | Swarm ID returned by research.swarm.start |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| swarmId | string | Swarm ID from input |
| dispatchId | string | Underlying dispatch ID |
| status | enum | Swarm status: "running", "complete", "failed" |
| completedTasks | number | Number of completed tasks |
| totalTasks | number | Total number of tasks |
| results | array of objects? | Per-query result counts when available (optional) |

Each result object:
- query: string
- resultCount: number

## Side effects

Read-only. Polls Inngest job store via agent.subagent.aggregate. ClickHouse
telemetry.

## Errors

None explicitly defined in the contract.
