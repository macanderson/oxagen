# agent.plan.create

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** agent
**Risk level:** low (requires approval)

## Intent

Propose a structured plan and persist it as an `execution_step` of
type `plan`. The plan awaits user approval before any side-effectful
step runs. Plan mode keeps the model honest about its intent and gives
the user a single decision point.

## Input

| Field             | Type                                                                                  | Notes                                            |
| ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `parentMessageId` | `string`                                                                              | Chat message that owns the plan.                 |
| `title`           | `string` (1 – 200)                                                                    | Plan title shown in the approval card.           |
| `steps`           | `Array<{ id, summary, intent, capability \| null, inputPreview \| null, dependsOn }>` | At least one step.                               |
| `rationale`       | `string?`                                                                             | Optional model-authored rationale.               |

## Output

| Field      | Type                  | Notes                              |
| ---------- | --------------------- | ---------------------------------- |
| `planId`   | `string`              | Prefixed with `plan_`.             |
| `status`   | `"pending_approval"`  | Always `pending_approval` here.    |

## Side effects

- Postgres: insert `execution.execution_steps` row with `step_type='plan'`, plus child rows for each step.
- ClickHouse: emit `agent.plan.created` row.

## Errors

| code             | meaning                                          |
| ---------------- | ------------------------------------------------ |
| `empty_plan`     | Steps array is empty.                            |
| `bad_dependency` | A `dependsOn` references an unknown step id.     |

## SPEC references

- §3 — plan mode
- §4 — new capabilities
