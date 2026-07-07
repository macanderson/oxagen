# notifications.list

**Domain:** notifications
**Mode:** sync
**Scope:** user (within workspace context)
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List in-app notifications for the calling user. Supports filtering to unread-only and pagination. Each user only sees their own notifications — this capability cannot be used to read another user's notifications.

## Input

| Field | Type | Notes |
|---|---|---|
| `unreadOnly` | `boolean` | When `true`, only returns unread notifications. Default: `false`. |
| `limit` | `number` | Max results (1–100, default 50). |

## Output

| Field | Type | Notes |
|---|---|---|
| `notifications[]` | `Notification[]` | Ordered by `createdAt` descending (newest first). |
| `notifications[].id` | `string` | Opaque notification ID. |
| `notifications[].publicId` | `string` | Public prefixed ID (`ntf_`). |
| `notifications[].kind` | `"system" \| "approval" \| "run" \| "member" \| "security"` | Notification category. |
| `notifications[].title` | `string` | Short notification title. |
| `notifications[].body` | `string \| null` | Optional longer body text. |
| `notifications[].deepLink` | `string \| null` | URL to the relevant resource (e.g. `/org/ws/settings/integrations`). |
| `notifications[].unread` | `boolean` | `true` if not yet read. |
| `notifications[].archived` | `boolean` | `true` if archived. |
| `notifications[].createdAt` | `string` | ISO 8601 timestamp. |
| `unreadCount` | `number` | Total unread count for the user (regardless of `limit`). |

## Roles

Any authenticated user (all org and workspace roles). Scoped to the calling user's notifications.

## Surfaces

- `GET /api/v1/{org}/{ws}/notifications`
- MCP tool `notifications_list`
- Available to agent toolchain
