# plugin.org.install_bulk

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Install multiple catalog or custom plugin servers to the org allow-list in one request (multi-select marketplace action). Per-item errors are captured — the operation is not all-or-nothing.

## Input

| Field | Type | Notes |
|---|---|---|
| `items[]` | `InstallItem[]` | 1–50 items to install. |
| `items[].catalogServerId` | `string?` | Catalog server public ID. |
| `items[].pluginType` | `"mcp_server" \| "integration" \| "content_tool"` | Default: `"mcp_server"`. |
| `items[].custom` | `object?` | Custom server descriptor (same shape as `plugin.org.install`). |

## Output

| Field | Type | Notes |
|---|---|---|
| `installed[]` | `InstalledItem[]` | Successfully installed items. |
| `installed[].catalogServerId` | `string \| null` | Catalog server ID (if from catalog). |
| `installed[].orgListingId` | `string \| null` | Created org listing public ID. |
| `installed[].authKind` | `\"oauth\" \| \"secret\" \| \"none\" \| null` | Effective auth kind for the installed listing (null on failure). |
| `installed[].error` | `string \| null` | Error message if this item failed. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: inserts one `plugin.org_listings` row per successful item, all with `enabled=false`.
- ClickHouse: emits `plugin.org.installed` event per item.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/org/install-bulk`
- MCP tool `plugin_org_install_bulk`
