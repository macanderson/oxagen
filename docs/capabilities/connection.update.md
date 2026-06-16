# connection.update

**Domain:** connection
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Update a data source connection: rename it (`displayName`) and/or adjust its
delivery configuration (sync schedule, scope). Partial — omit a field to leave
it unchanged. Pausing/resuming is `connection.pause`; deletion is
`connection.delete`.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| connectionId | string | Public ID (`con_*`) or internal UUID |
| displayName | string? | New display name |
| deliveryConfig | object \| null? | Replacement delivery config (schedule/scope); null clears |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| connectionId | string | The updated connection |
| displayName | string | Current display name |
| status | string | Current connection status |
| deliveryConfig | object \| null | Current delivery config |

## Side effects

Updates the `source_connections` row (org + workspace scoped, soft-delete aware).
ClickHouse observes the write via the kernel.

## Errors

- Throws 404 when the connection does not exist in the caller's org + workspace.
