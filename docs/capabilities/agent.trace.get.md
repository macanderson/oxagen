# agent.trace.get

**Domain:** agent
**Mode:** sync
**Scope:** tenant (org + workspace)
**Requires approval:** no
**Risk level:** low

## Intent

Fetch one agent execution as a collapsible **span tree** — the run itself, its
ordered steps, each step's tool calls (with durations, token/cost figures, and
status), and any child executions linked via `parent_execution_id` (subagent /
A2A lineage). Powers the in-app run-trace viewer and is callable from the
agent, MCP, and API surfaces.

The durable source of truth for the tree is **Postgres** (`agent.agent_executions`
→ `agent.agent_execution_steps` → `agent.agent_tool_calls`). ClickHouse holds
the high-volume analytics mirror; Neo4j does not carry the execution→execution
parent edge, so the tree is read from Postgres.

## Input

| Field         | Type     | Default | Notes                                              |
| ------------- | -------- | ------- | -------------------------------------------------- |
| `executionId` | `string` | —       | Public ID (`aex_…`) or UUID of the execution.      |

## Output

A recursive execution node (the root of the tree):

| Field              | Type                      | Notes                                                       |
| ------------------ | ------------------------- | ----------------------------------------------------------- |
| `executionId`      | `string`                  | `aex_*` public ID.                                          |
| `status`           | enum                      | `planning` \| `running` \| `completed` \| `failed` \| `cancelled`. |
| `originType`       | `string`                  | `chat` \| `event_trigger` \| `scheduled_job` \| `mcp_request` \| `workflow_run` \| `fanout`. |
| `originId`         | `string` (UUID)           | The originating entity.                                     |
| `agentId`          | `string \| null`          | Agent definition, when the run has one.                     |
| `failureReason`    | `string \| null`          | Present when the run failed.                                |
| `startedAt`        | `string \| null` (ISO)    | —                                                           |
| `completedAt`      | `string \| null` (ISO)    | —                                                           |
| `latencyMs`        | `number \| null`          | Wall-clock duration.                                        |
| `inputTokens`      | `number \| null`          | —                                                           |
| `outputTokens`     | `number \| null`          | —                                                           |
| `estimatedCostUsd` | `string \| null`          | Numeric string (6 dp).                                      |
| `createdAt`        | `string` (ISO)            | —                                                           |
| `updatedAt`        | `string` (ISO)            | —                                                           |
| `steps`            | `Step[]`                  | Ordered by `stepNumber`.                                    |
| `children`         | `ExecutionNode[]`         | Child executions (recursive; bounded).                      |

Each **Step** carries `stepId`, `stepNumber`, `stepType`, `status`,
`failureReason`, `startedAt`, `completedAt`, `latencyMs`, `inputTokens`,
`outputTokens`, and `toolCalls[]`. Each **ToolCall** carries `toolCallId`,
`toolName`, `toolType`, `status`, `latencyMs`, `inputTokens`, `outputTokens`,
`requestBytes`, `responseBytes`, and a bounded `responsePreview`.

## Bounds

The descendant traversal is capped (max 200 nodes, max depth 10) so a
pathological lineage chain can never fan the read into an unbounded query storm
or an unbounded client payload. Tool-call and step response previews are
truncated to 500 characters.

## Side effects

None — read-only. Metering / IAM / audit are emitted by the kernel `invoke()`
path like any capability.

## Errors

| code                  | meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `execution_not_found` | Unknown, purged, or cross-tenant `executionId` → HTTP 404. |
| `forbidden`           | Caller lacks read permission on the agent domain.          |

## Surfaces

- **API:** `GET /v1/{org}/{ws}/agent/trace/:executionId`
- **MCP:** tool `agent.trace.get`
- **App:** run-trace page under the workspace Activity section.
