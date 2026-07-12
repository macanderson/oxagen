# automation.get

**Domain:** automation
**Mode:** sync
**Scope:** tenant (org + workspace)

## Intent

Fetch one automation's full detail — trigger config, description, active-version
steps, and recent run history — by its trigger public ID. This is the missing
read path behind the Automations editor page: `automation.list` returns just
enough to render a table row, `automation.get` returns everything needed to
render and edit a single automation.

## Input

| Field           | Type     | Notes                                           |
| --------------- | -------- | ------------------------------------------------ |
| `automation_id` | `string` | Trigger public ID (`plt_*`) from `automation.list`. |

## Output

| Field           | Type                        | Notes                                                       |
| ---------------- | --------------------------- | ------------------------------------------------------------ |
| `automation_id`  | `string`                    | Trigger public ID (`plt_*`).                                  |
| `playbook_id`    | `string`                    | Parent playbook public ID (`plb_*`).                          |
| `name`           | `string`                    | Playbook name.                                                |
| `description`    | `string \| null`            | Playbook description.                                         |
| `status`         | `string`                    | Playbook status: `draft` \| `active` \| `archived`.           |
| `triggerType`    | `"event" \| "schedule" \| "api"` | Trigger type.                                              |
| `enabled`        | `boolean`                   | Whether the trigger is live.                                  |
| `triggerConfig`  | `object`                    | Trigger-type-specific configuration.                           |
| `steps`          | `array`                     | Steps of the playbook's active version, in creation order.     |
| `steps[].stepKey`   | `string` | Stable step key within the version.                                        |
| `steps[].name`      | `string` | Step display name.                                                          |
| `steps[].stepType`  | `string` | Step type (`agent`, `tool`, `condition`, etc).                              |
| `steps[].config`    | `object` | Step-type-specific configuration.                                           |
| `runs`           | `array`                     | Up to 20 most recent runs, newest first.                       |
| `runs[].id`          | `string`         | Run ID.                                                                  |
| `runs[].status`      | `string`         | Run status (`pending`, `running`, `completed`, `failed`, etc).            |
| `runs[].source`      | `string`         | What started the run (`api`, `event`, `schedule`, `manual`, `sub_playbook`). |
| `runs[].startedAt`   | `string \| null` | ISO timestamp, or `null` if not yet started.                              |
| `runs[].completedAt` | `string \| null` | ISO timestamp, or `null` if not yet completed.                            |
| `runs[].createdAt`   | `string`         | ISO timestamp the run record was created.                                 |

`steps` is an empty array when the playbook has no active version yet.

## Errors

| code          | meaning                                                                 |
| ------------- | ------------------------------------------------------------------------ |
| `forbidden`   | Caller lacks permission to read this automation.                        |
| (thrown)      | `automation.get: automation not found` — no matching trigger (scoped to org+workspace), or its playbook is missing/soft-deleted. |

## SPEC references

- docs/architecture/workflow/spec.md — §automation.get
