# automation.trigger

**Domain:** automation
**Mode:** sync
**Scope:** tenant (org + workspace)

## Intent

Manually trigger an automation by ID with an optional payload. Creates an `automation_runs` row and dispatches the automation action.

## Input

| Field           | Type                   | Notes                                             |
| --------------- | ---------------------- | ------------------------------------------------- |
| `automation_id` | `string`               | ID of the automation to trigger.                  |
| `payload`       | `Record<string, unknown>` (opt.) | Optional event payload passed to the action. |

## Output

| Field          | Type     | Notes                                          |
| -------------- | -------- | ---------------------------------------------- |
| `execution_id` | `string` | ID of the created `automation_runs` row.       |
| `status`       | `string` | Initial status: `running`.                     |

## Side effects

- Postgres: inserts `workflow.automation_runs` row.
- Inngest: dispatches the automation action function.

## Errors

| code        | meaning                                                   |
| ----------- | --------------------------------------------------------- |
| `not_found` | No automation with the given ID in the workspace.         |
| `forbidden` | Caller lacks permission to trigger automations.           |
| `paused`    | Automation is currently paused.                           |

## SPEC references

- docs/architecture/workflow/spec.md — §automation.trigger
