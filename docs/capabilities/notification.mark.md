# notifications.mark

**Domain:** notifications
**Mode:** sync
**Scope:** user
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Mark a notification as read and/or archived for the calling user. Users may only mark their own notifications — attempting to mark another user's notification returns a not-found error.

## Input

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Public ID of the notification to update (`ntf_` prefix). |
| `read` | `boolean?` | When `true`, sets the notification as read (`unread = false`). |
| `archived` | `boolean?` | When `true`, archives the notification. |

At least one of `read` or `archived` must be provided.

## Output

| Field | Type | Notes |
|---|---|---|
| `ok` | `boolean` | `true` on success. |

## Roles

Any authenticated user (all org and workspace roles). Scoped to the calling user's notifications.

## Side effects

- Postgres: updates `notifications.user_id = ctx.userId` row (read/archived flags).
- When archiving: the notification is hidden from the default bell-menu view.
- ClickHouse: emits `notifications.marked` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/notifications/mark`
- MCP tool `notifications_mark`
- Available to agent toolchain
