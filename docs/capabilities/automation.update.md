# automation.update

**Domain:** automation
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Edit an existing automation: rename it, change its description, and/or replace
its trigger configuration (event conditions or schedule). Enable/disable is
intentionally a separate, human-gated path (`automation.enable` /
`automation.disable`). Partial update — omit a field to leave it unchanged.

An automation is a `(playbookTriggers, playbooks)` pair: `name`/`description`
live on the playbook; the trigger configuration lives on the trigger row.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| automation_id | string | Trigger public ID (`plt_*`) |
| name | string? | New name (omit to keep) |
| description | string \| null? | New description; null clears, omit keeps |
| triggerConfig | object? | Full replacement of the trigger config (event/schedule fields) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| automation_id | string | The updated trigger public ID |
| name | string | Current playbook name |
| description | string \| null | Current description |
| status | string | Current playbook status |
| triggerType | string | `event`, `schedule`, or `api` |
| enabled | boolean | Whether the trigger is live |

## Side effects

Updates the playbook and/or trigger rows (org + workspace scoped) in one
transaction. ClickHouse observes the write via the kernel. Does not change the
enabled state.

## Errors

- Requires an authenticated user.
- Throws when the trigger is not found in the caller's org + workspace.
