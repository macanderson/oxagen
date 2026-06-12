# automation.disable

**Domain:** automation
**Mode:** sync
**Scope:** tenant (org + workspace)

## Intent

Disable an automation trigger so it stops firing. Disabling is always safe (turning an automation OFF can never cause an autonomous side effect), so unlike `automation.enable` it requires no approval and AI agents may call it freely.

Sets `workflow.playbook_triggers.is_enabled = false` and the parent playbook's status back to `draft` (the nearest paused-equivalent in the playbooks status enum).

## Input

| Field           | Type             | Notes                                                          |
| --------------- | ---------------- | -------------------------------------------------------------- |
| `automation_id` | `string` (min 1) | Trigger public ID returned by `automation.create` / `automation.list`. |

## Output

| Field           | Type      | Notes                                  |
| --------------- | --------- | --------------------------------------- |
| `automation_id` | `string`  | Echoes the trigger public ID.           |
| `enabled`       | `boolean` | `false` after a successful disable.     |
| `status`        | `string`  | `paused` once disabled.                 |

## Side effects

- Postgres: sets `workflow.playbook_triggers.is_enabled = false`, stamps `updated_by_user_id`.
- Postgres: sets the parent `workflow.playbooks.status = 'draft'`.

## Errors

| code        | meaning                                                          |
| ----------- | ----------------------------------------------------------------- |
| `not_found` | No trigger with this public ID exists in the caller's workspace.  |
| `forbidden` | Caller lacks permission to disable automations.                   |

## SPEC references

- docs/architecture/workflow/spec.md — §automation.disable
