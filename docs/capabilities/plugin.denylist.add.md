# plugin.denylist.add

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Add a plugin server name to the org denylist. Immediately disables and removes any matching org listings and workspace installs. The server remains visible in the marketplace with a "Blocked" badge but cannot be installed while on the denylist.

## Input

| Field | Type | Notes |
|---|---|---|
| `serverName` | `string` | Reverse-DNS server name to deny (e.g. `io.github.acme.my-server`). |
| `pluginType` | `"mcp_server" \| "integration" \| "content_tool"` | Default: `"mcp_server"`. |
| `reason` | `string?` | Optional human-readable reason shown in the UI. |

## Output

| Field | Type | Notes |
|---|---|---|
| `ok` | `boolean` | `true` on success. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: inserts `plugin.org_denylist` row.
- Postgres: disables and soft-deletes any `plugin.org_listings` rows with matching `name`.
- Postgres: deletes dependent `agent.mcp_servers` rows.
- ClickHouse: emits `plugin.denylist.added` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/denylist/add`
- MCP tool `plugin_denylist_add`
