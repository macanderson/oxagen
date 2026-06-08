# workflow.status

**Domain:** workflow
**Mode:** sync
**Scope:** tenant (org + workspace)

## Intent

Read the current status and task-level progress of a workflow run. Returns the full `workflow_runs` row plus all associated `workflow_run_tasks` rows.

## Input

| Field        | Type     | Notes                                              |
| ------------ | -------- | -------------------------------------------------- |
| `workflowId` | `string` | Public ID (`wfr_*`) or internal UUID of the run.  |

## Output

| Field      | Type             | Notes                                                                         |
| ---------- | ---------------- | ----------------------------------------------------------------------------- |
| `workflow` | `WorkflowRun`    | Full run record (status, totalTasks, completedTasks, failedTasks, resultUrl). |
| `tasks`    | `WorkflowTask[]` | All tasks for the run (each with status, goal, output).                       |

Status values: `planning` → `running` → `completed` \| `failed` \| `cancelled`.

## Errors

| code        | meaning                                                     |
| ----------- | ----------------------------------------------------------- |
| `not_found` | No workflow run with the given ID in the caller's workspace.|
| `forbidden` | Caller lacks `workflow:read` permission.                    |

## SPEC references

- docs/architecture/workflow/spec.md — §workflow.status
