# agent.execution.record

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Persist a complete agent execution record including steps and tool calls for
observability, billing, and audit.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| agentId | string (UUID) | Agent identifier |
| agentVersionId | string (UUID) | Agent version identifier |
| originType | string | Origin type (e.g., "chat", "workflow") |
| originId | string (UUID) | Origin record ID |
| status | enum | Execution status: "planning", "running", "completed", "failed", "cancelled" |
| inputPayload | unknown | Input data provided to the agent |
| outputPayload | unknown? | Output data from the agent (optional) |
| failureReason | string? | Error message if status is "failed" (optional) |
| startedAt | date? | Execution start time (optional) |
| completedAt | date? | Execution completion time (optional) |
| latencyMs | number? | Execution duration in milliseconds (optional) |
| inputTokens | number? | Tokens consumed as input (optional) |
| outputTokens | number? | Tokens produced as output (optional) |
| estimatedCostUsd | number? | Estimated cost in USD (optional) |
| steps | array of objects? | Execution steps with details and tool calls (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| executionId | string (UUID) | Unique identifier for this execution record |
| status | string | Recorded execution status |
| createdAt | date | Timestamp when the record was persisted |

## Side effects

Records written to Postgres (executions table) and ClickHouse (telemetry events).
May trigger billing meter increments based on tokens.

## Errors

None explicitly defined in the contract.
