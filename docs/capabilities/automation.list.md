# automation.list

**Domain:** automation
**Mode:** sync
**Scope:** tenant (org + workspace)

## Intent

List automation rules in the caller's active workspace, ordered by creation date descending.

## Input

| Field          | Type               | Notes                                    |
| -------------- | ------------------ | ---------------------------------------- |
| `workspace_id` | `string` (opt.)    | Defaults to caller's active workspace.   |

## Output

An array of automation objects, each with:

| Field      | Type       | Notes                                         |
| ---------- | ---------- | --------------------------------------------- |
| `id`       | `string`   | Internal ID.                                  |
| `name`     | `string`   | Human-readable name.                          |
| `status`   | `string`   | `active` \| `paused` \| `archived`.           |
| `triggers` | `string[]` | Trigger descriptor strings.                   |

## Errors

| code        | meaning                                               |
| ----------- | ----------------------------------------------------- |
| `forbidden` | Caller lacks permission to list automations.          |

## SPEC references

- docs/architecture/workflow/spec.md — §automation.list
