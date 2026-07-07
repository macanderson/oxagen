# agent.task.background.cancel

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium (requires approval)

## Intent

Cancel a running background task. Downstream Inngest steps stop on
the next checkpoint; partial side effects already committed are not
rolled back.

## Input

| Field    | Type      | Notes                                          |
| -------- | --------- | ---------------------------------------------- |
| `taskId` | `string`  | Task id from `agent.task.background.start`.    |
| `reason` | `string?` | Optional human reason; attached to audit row.  |

## Output

| Field    | Type                                                       | Notes                              |
| -------- | ---------------------------------------------------------- | ---------------------------------- |
| `taskId` | `string`                                                   | Echoes the input id.               |
| `status` | `"cancelled" \| "already_completed" \| "already_cancelled"` | Resolved state after the call.     |

## Side effects

- Inngest: call `inngest.cancellation` for the task's run id.
- Postgres: update `agent.background_tasks.status` and emit a cancellation audit row.
- ClickHouse: emit `agent.task.cancelled` row.

## Errors

| code           | meaning                                          |
| -------------- | ------------------------------------------------ |
| `unknown_task` | The `taskId` does not exist in this workspace.   |

## SPEC references

- §3 — background tasks
- §4 — new capabilities
