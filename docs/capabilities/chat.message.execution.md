# chat.message.execution

**Domain:** chat
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Record an agent execution that originated from a chat message; atomically links
the execution to the message for observability and UI streaming.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| messageId | string (UUID) | Chat message ID that triggered execution |
| agentId | string (UUID) | Agent identifier |
| agentVersionId | string (UUID) | Agent version identifier |
| originType | literal | Must be "chat" |
| originId | string (UUID) | Conversation or thread ID |
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
| updateMessageMetadata | boolean | Update message metadata with execution details (default: true) |
| steps | array of objects? | Execution steps with details and tool calls (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| executionId | string (UUID) | Unique identifier for this execution record |
| status | string | Recorded execution status |
| createdAt | date | Timestamp when the record was persisted |

## Side effects

Records written to Postgres (executions table and messages.metadata).
ClickHouse telemetry events. Updates message streaming metadata for UI.

## Errors

None explicitly defined in the contract.
