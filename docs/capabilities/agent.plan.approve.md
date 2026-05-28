# agent.plan.approve

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, agent
**Risk level:** low

## Intent

Approve, deny, or amend a previously-proposed plan. Approval releases
the agent stream to execute the plan's side-effectful steps; denial
ends the plan; amendment replaces the steps and re-enters plan mode.

## Input

| Field          | Type                                                                                  | Notes                                                          |
| -------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `planId`       | `string`                                                                              | Plan id from `agent.plan.create`.                              |
| `decision`     | `"approve" \| "deny" \| "amend"`                                                      | Required.                                                      |
| `amendedSteps` | `Array<{ id, summary, intent, capability \| null, inputPreview \| null, dependsOn }>?` | Required when `decision === "amend"`.                          |
| `note`         | `string?`                                                                             | Optional human note attached to the audit row.                 |

## Output

| Field    | Type                              | Notes                                  |
| -------- | --------------------------------- | -------------------------------------- |
| `planId` | `string`                          | Echoes the input plan id.              |
| `status` | `"approved" \| "denied" \| "amended"` | Resolved plan status.              |

## Side effects

- Postgres: update `execution.execution_steps` row for the plan; insert audit row in `execution.execution_step_events`.
- SSE: emit a `plan.resolved` event so the chat stream resumes.
- ClickHouse: emit `agent.plan.resolved` row.

## Errors

| code               | meaning                                          |
| ------------------ | ------------------------------------------------ |
| `unknown_plan`     | The `planId` does not exist in this workspace.   |
| `already_resolved` | Plan is no longer `pending_approval`.            |
| `missing_amendment` | `decision === "amend"` without `amendedSteps`. |

## SPEC references

- §3 — plan mode
- §4 — new capabilities
