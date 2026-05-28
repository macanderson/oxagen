# agent.task.background.read

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the current status, progress markers, and final result of a
background task. The tasks tray polls this on a backoff schedule; the
agent reads it once it decides to surface the result.

## Input

| Field    | Type     | Notes                                          |
| -------- | -------- | ---------------------------------------------- |
| `taskId` | `string` | Task id from `agent.task.background.start`.    |

## Output

| Field           | Type                                                                            | Notes                              |
| --------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| `taskId`        | `string`                                                                        | Echoes the input id.               |
| `kind`          | `string`                                                                        | Task kind.                         |
| `status`        | `"pending" \| "running" \| "completed" \| "failed" \| "cancelled"`              | Current status.                    |
| `label`         | `string \| null`                                                                | Display label.                     |
| `resultPayload` | `unknown \| null`                                                               | Final payload when `completed`.    |
| `failureReason` | `string \| null`                                                                | Set when `failed`.                 |
| `createdAt`     | `string` (ISO)                                                                  | Creation timestamp.                |
| `startedAt`     | `string \| null`                                                                | First-attempt timestamp.           |
| `completedAt`   | `string \| null`                                                                | Terminal-state timestamp.          |

## Side effects

None — read-only against `agent.background_tasks`.

## Errors

| code           | meaning                                          |
| -------------- | ------------------------------------------------ |
| `unknown_task` | The `taskId` does not exist in this workspace.   |

## SPEC references

- §3 — background tasks
- §4 — new capabilities
