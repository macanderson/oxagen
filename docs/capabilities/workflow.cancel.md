# workflow.cancel

**Domain:** workflow
**Mode:** sync
**Scope:** tenant (org + workspace)
**Requires approval:** yes (agent surface)
**Risk level:** medium

## Intent

Cancel a running or planning workflow run, stopping all in-flight sub-tasks. The workflow run transitions to `cancelled` status; tasks already in `completed` or `failed` state are not rolled back.

## Input

| Field        | Type     | Notes                                              |
| ------------ | -------- | -------------------------------------------------- |
| `workflowId` | `string` | Public ID (`wfr_*`) or internal UUID of the run.  |

## Output

| Field       | Type      | Notes                                              |
| ----------- | --------- | -------------------------------------------------- |
| `cancelled` | `boolean` | `true` when the cancellation was applied.          |

## Side effects

- Postgres: updates `workflow.workflow_runs.status` → `cancelled`.
- Inngest: signals in-flight fan-out tasks to stop.

## Errors

| code               | meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| `not_found`        | No workflow run with the given ID in the caller's workspace.|
| `already_terminal` | The workflow already reached a terminal state.              |
| `forbidden`        | Caller lacks `workflow:cancel` permission.                  |

## SPEC references

- docs/architecture/workflow/spec.md — §workflow.cancel
