# plugin.denylist.remove

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Remove a plugin server name from the org denylist, making it installable again. Does not automatically reinstall the server — admins must install it again from the marketplace if desired.

## Input

| Field | Type | Notes |
|---|---|---|
| `serverName` | `string` | The server name to remove from the denylist. |
| `pluginType` | `"mcp_server" \| "integration" \| "content_tool"` | Plugin type (default: `"mcp_server"`). |

## Output

| Field | Type | Notes |
|---|---|---|
| `ok` | `boolean` | `true` on success. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: deletes the matching `plugin.org_denylist` row.
- ClickHouse: emits `plugin.denylist.removed` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/denylist/remove`
- MCP tool `plugin_denylist_remove`
