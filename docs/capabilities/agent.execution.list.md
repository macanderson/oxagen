# agent.execution.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant (org + workspace)
**Requires approval:** no
**Risk level:** low

## Intent

List recent **top-level** agent runs (executions) for the workspace, newest
first, with keyset pagination on `created_at`. Only root executions
(`parent_execution_id IS NULL`) are returned — one row per run. Expand a run
into its steps, tool calls, and child executions with
[agent.trace.get](agent.trace.get.md). Backs the in-app Activity list and is
callable from the agent, MCP, and API surfaces.

## Input

| Field    | Type                                        | Default | Notes                                                         |
| -------- | ------------------------------------------- | ------- | ------------------------------------------------------------- |
| `limit`  | `integer` (1 – 100)                         | `25`    | Max runs to return.                                           |
| `before` | `string` (ISO datetime, opt.)               | —       | Keyset cursor: runs created strictly before this timestamp.   |
| `status` | enum (opt.)                                 | —       | `planning` \| `running` \| `completed` \| `failed` \| `cancelled`. |

## Output

| Field         | Type              | Notes                                                        |
| ------------- | ----------------- | ------------------------------------------------------------ |
| `executions`  | `Execution[]`     | Newest first. Each carries `executionId`, `status`, `originType`, `originId`, `agentId`, `startedAt`, `completedAt`, `latencyMs`, `inputTokens`, `outputTokens`, `estimatedCostUsd`, `createdAt`. |
| `nextCursor`  | `string \| null`  | Pass as `before` to fetch the next page; `null` when no more rows. |

## Pagination

Keyset (not offset): the handler over-fetches one row to compute `nextCursor`,
so deep pages stay cheap and stable under concurrent inserts.

## Side effects

None — read-only.

## Errors

| code        | meaning                                            |
| ----------- | -------------------------------------------------- |
| `forbidden` | Caller lacks read permission on the agent domain.  |

## Surfaces

- **API:** `GET /v1/{org}/{ws}/agent/executions?limit=&before=&status=`
- **MCP:** tool `agent.execution.list`
- **App:** run Activity index under the workspace section.
