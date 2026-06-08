# workflow.run

**Domain:** workflow
**Mode:** async
**Scope:** tenant (org + workspace)
**Requires approval:** yes (agent surface)
**Risk level:** medium

## Intent

Decompose a large parallel goal into N sub-tasks, dispatch them concurrently via Inngest, and return a live progress render component. Use for 10+ parallel data-gathering steps where the result set is too large to process sequentially in a single LLM context.

## Input

| Field            | Type                    | Default  | Notes                                              |
| ---------------- | ----------------------- | -------- | -------------------------------------------------- |
| `goal`           | `string` (1 – 2000 ch.) | —        | Overarching research or processing goal.           |
| `title`          | `string` (opt.)         | —        | Optional display title shown in the UI.            |
| `outputFormat`   | `"json"` \| `"csv"`     | `"json"` | Format for the aggregated result.                  |
| `maxParallelism` | `integer` (1 – 100)     | `50`     | Maximum concurrent sub-tasks.                      |

## Output

| Field        | Type              | Notes                                                          |
| ------------ | ----------------- | -------------------------------------------------------------- |
| `workflowId` | `string` (UUID)   | Internal UUID of the `workflow_runs` row.                      |
| `publicId`   | `string`          | `wfr_*` prefixed public ID.                                    |
| `status`     | `"planning"`      | Always `planning` on creation; transitions via Inngest.        |
| `render`     | `object`          | `{ componentId: "workflow-progress", props: { workflowId } }` |

## Side effects

- Postgres: inserts `workflow.workflow_runs`.
- Inngest: enqueues the AI planner function to decompose the goal and dispatch sub-task functions.

## Errors

| code             | meaning                                       |
| ---------------- | --------------------------------------------- |
| `invalid_goal`   | Goal string fails validation.                 |
| `forbidden`      | Caller lacks `workflow:run` permission.       |
| `quota_exceeded` | Workspace has reached its concurrent run cap. |

## SPEC references

- docs/architecture/workflow/spec.md — §workflow.run
