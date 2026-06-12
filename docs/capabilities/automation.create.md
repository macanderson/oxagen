# automation.create

**Domain:** automation
**Mode:** sync
**Scope:** tenant (org + workspace)

## Intent

Create a playbook and trigger for an automation. `triggerType='event'` watches graph node changes (e.g. Contact status changes), `'schedule'` runs on a cron, and `'api'` is manually triggered. The `steps` array scaffolds the initial action; leave it empty to create a blank playbook.

**Human gate:** automations created by an AI agent ALWAYS start disabled regardless of the `enabled` input. The `enabled` flag is honored only for human-origin calls — direct API/app requests with no in-chat `messageId`. MCP and runner surfaces, and any call carrying a chat `messageId`, are AI-origin and force `enabled = false`. A human must explicitly activate via `automation.enable`.

## Input

| Field           | Type                              | Notes                                                                  |
| --------------- | --------------------------------- | ----------------------------------------------------------------------- |
| `name`          | `string` (1–120)                  | Human-readable automation name.                                         |
| `description`   | `string` (opt., ≤500)             | What this automation does and when it fires.                            |
| `triggerType`   | `'event' \| 'schedule' \| 'api'`  | How the automation is triggered.                                        |
| `triggerConfig` | `object` (default `{}`)           | Trigger-type-specific configuration (see below).                        |
| `steps`         | `array` (default `[]`)            | Initial steps to scaffold: `{name, stepType, config}` per step.         |
| `enabled`       | `boolean` (default `false`)       | Whether the trigger starts enabled. Forced to `false` for AI-origin calls. |

### triggerConfig — cross-field validation

| triggerType  | Required fields            | Optional fields                  |
| ------------ | -------------------------- | -------------------------------- |
| `event`      | `entityType`, `eventType`  | `propertyConditions`             |
| `schedule`   | `cronExpression`           | `timezone` (IANA, default UTC)   |
| `api`        | —                          | —                                |

`eventType` is one of `node.created \| node.updated \| node.deleted`. `propertyConditions` is an array of `{property, fromValue?, toValue?, operator}` where `operator` is `eq \| gt \| lt \| changed` (default `eq`). Missing required fields throw a validation error.

## Output

| Field           | Type      | Notes                                                                 |
| --------------- | --------- | ---------------------------------------------------------------------- |
| `automation_id` | `string`  | Trigger public ID — use with `automation.trigger` / `automation.enable`. |
| `playbook_id`   | `string`  | Playbook public ID.                                                    |
| `name`          | `string`  | Echoes the stored name.                                                |
| `status`        | `string`  | `active` when the trigger starts enabled, else `inactive`.             |
| `triggerType`   | `string`  | Echoes the trigger type.                                               |
| `enabled`       | `boolean` | Whether the trigger is live. `false` when created by an AI agent — call `automation.enable` (human-gated) to activate. |

## Side effects

- Postgres: inserts `workflow.playbooks` (status `active` when starting enabled, else `draft`), `workflow.playbook_versions` (v1, published), `workflow.playbook_steps`, and `workflow.playbook_triggers` rows.

## Errors

| code         | meaning                                                                    |
| ------------ | --------------------------------------------------------------------------- |
| `validation` | `event` trigger missing `entityType`/`eventType`, or `schedule` trigger missing `cronExpression`. |
| `forbidden`  | Caller lacks permission to create automations.                              |

## SPEC references

- docs/architecture/workflow/spec.md — §automation.create
