# plugin.org.install

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Install a catalog server (from the marketplace) or a custom server to the org allow-list. The installed server is **disabled by default** — it must be explicitly enabled before workspace agents can use it.

## Input

| Field | Type | Notes |
|---|---|---|
| `pluginType` | `"mcp_server" \| "integration" \| "content_tool" \| "capability"` | Default: `"mcp_server"`. Pass `"capability"` to install an Oxagen Plugin. |
| `pluginId` | `string?` | Required when `pluginType` is `"capability"`. The stable Oxagen Plugin id (e.g. `"oxagen/media-video"`). Validated against the in-process plugin registry. |
| `catalogServerId` | `string?` | Public ID of a catalog server to install. Mutually exclusive with `custom` and `pluginId`. |
| `custom` | `object?` | Custom server descriptor — mutually exclusive with `catalogServerId` and `pluginId`. |
| `custom.name` | `string` | Unique server name (reverse-DNS recommended). |
| `custom.title` | `string?` | Display title. |
| `custom.description` | `string?` | Short description. |
| `custom.endpointUrl` | `string` | MCP endpoint URL. |
| `custom.transport` | `string` | `"streamable-http"` or `"sse"`. |
| `custom.authKind` | `"oauth" \| "secret" \| "none"` | Authentication kind. |

## Output

| Field | Type | Notes |
|---|---|---|
| `orgListingId` | `string` | Public ID of the created `plugin.org_listings` row. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: inserts `plugin.org_listings` row with `enabled=false`.
- ClickHouse: emits `plugin.org.installed` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/org/install`
- MCP tool `plugin_org_install`
