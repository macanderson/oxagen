# agent.task.background.start

**Domain:** agent
**Mode:** async
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium (requires approval)

## Intent

Dispatch a long-running task as a durable Inngest job. The chat
returns a task handle immediately; the user monitors progress in the
workspace-scoped tasks tray and reads results via
`agent.task.background.read`.

## Input

| Field     | Type      | Notes                                          |
| --------- | --------- | ---------------------------------------------- |
| `kind`    | `string`  | Task kind, mapped to an Inngest function name. |
| `payload` | `unknown` | Opaque payload; validated by the kind handler. |
| `label`   | `string?` | Display label for the tasks tray.              |

## Output

| Field          | Type     | Notes                                  |
| -------------- | -------- | -------------------------------------- |
| `taskId`       | `string` | Prefixed with `task_`.                 |
| `inngestRunId` | `string` | Inngest run id for cross-referencing.  |

## Side effects

- Inngest: send the matching `agent.task.<kind>` event.
- Postgres: insert `agent.background_tasks` row with status `pending`.
- ClickHouse: emit `agent.task.started` row.

## Errors

| code               | meaning                                          |
| ------------------ | ------------------------------------------------ |
| `unknown_kind`     | No Inngest function registered for this kind.    |
| `payload_invalid`  | Payload failed kind-specific validation.         |
| `over_concurrency` | Workspace task concurrency cap exceeded.         |

## SPEC references

- §3 — background tasks
- §4 — new capabilities
