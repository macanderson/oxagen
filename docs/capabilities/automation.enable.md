# automation.enable

**Domain:** automation
**Mode:** sync
**Scope:** tenant (org + workspace)

## Intent

Enable an automation trigger so it fires live. This is the ONLY path from "configured" to "live" — AI agents may create and edit automations, but activation must cross a human gate: the agent surface renders an approval card (`requiresApproval: true`), MCP hosts surface their own tool-call confirmation, and API calls are human-initiated by construction.

Sets `workflow.playbook_triggers.is_enabled = true` and the parent playbook's status to `active`.

## Input

| Field           | Type             | Notes                                                          |
| --------------- | ---------------- | -------------------------------------------------------------- |
| `automation_id` | `string` (min 1) | Trigger public ID returned by `automation.create` / `automation.list`. |

## Output

| Field           | Type      | Notes                                  |
| --------------- | --------- | --------------------------------------- |
| `automation_id` | `string`  | Echoes the trigger public ID.           |
| `enabled`       | `boolean` | `true` after a successful enable.       |
| `status`        | `string`  | `active` once enabled.                  |

## Side effects

- Postgres: sets `workflow.playbook_triggers.is_enabled = true`, stamps `updated_by_user_id`.
- Postgres: sets the parent `workflow.playbooks.status = 'active'`.

## Errors

| code        | meaning                                                          |
| ----------- | ----------------------------------------------------------------- |
| `not_found` | No trigger with this public ID exists in the caller's workspace.  |
| `forbidden` | Caller lacks permission to enable automations.                    |

## SPEC references

- docs/architecture/workflow/spec.md — §automation.enable
