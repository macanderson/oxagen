# automation.create

**Domain:** automation
**Mode:** sync
**Scope:** tenant (org + workspace)

## Intent

Create a new automation rule with a trigger and action, stored in `workflow.automations`. Automations are trigger→action rules distinct from multi-step workflows.

## Input

| Field     | Type               | Notes                                              |
| --------- | ------------------ | -------------------------------------------------- |
| `name`    | `string` (min 1)   | Human-readable automation name.                    |
| `trigger` | `string` (opt.)    | Trigger descriptor string.                         |
| `action`  | `string` (opt.)    | Action payload descriptor string.                  |

## Output

| Field           | Type     | Notes                                          |
| --------------- | -------- | ---------------------------------------------- |
| `automation_id` | `string` | Internal ID of the created automation.         |
| `name`          | `string` | Echoes the stored name.                        |
| `status`        | `string` | Initial status: `active`.                      |

## Side effects

- Postgres: inserts `workflow.automations` row (status `active`).

## Errors

| code        | meaning                                              |
| ----------- | ---------------------------------------------------- |
| `forbidden` | Caller lacks permission to create automations.       |

## SPEC references

- docs/architecture/workflow/spec.md — §automation.create
