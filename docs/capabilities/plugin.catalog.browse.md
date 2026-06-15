# plugin.catalog.browse

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Search and filter the MCP server catalog (latest versions) by text, category, transport, and auth kind. Returns paginated results from all registries available to the org.

## Input

| Field | Type | Notes |
|---|---|---|
| `search` | `string?` | Full-text search string applied to name, title, and description. |
| `pluginType` | `"mcp_server" \| "integration" \| "content_tool" \| "capability"?` | Filter by plugin type. Passing `"capability"` serves results from the static Oxagen Plugin registry instead of `mcp.catalog_servers`. Omitting the field returns only catalog servers (legacy behaviour preserved). |
| `authKind` | `"oauth" \| "secret" \| "none"?` | Filter by authentication kind. Ignored when `pluginType` is `"capability"`. |
| `categories` | `string[]?` | Filter to servers in any of these categories. Ignored when `pluginType` is `"capability"`. |
| `installed` | `boolean?` | Filter by install status within the org (and optional `workspaceId`) scope: `true` returns only installed plugins, `false` only not-yet-installed, omit for all. Requires org context; an org-less browse treats everything as not installed. |
| `limit` | `number?` | Max results per page (1–100, default 20). |
| `offset` | `number?` | Pagination offset. |

## Output

| Field | Type | Notes |
|---|---|---|
| `servers[]` | `CatalogSummary[]` | Array of catalog server summaries. |
| `total` | `number` | Total matching records (for pagination UI). |
| `nextOffset` | `number \| null` | Offset for the next page, or `null` if last page. |

### Additional fields on capability entries

When `pluginType` is `"capability"`, each entry in `servers[]` includes two additional fields:

| Field | Type | Notes |
|---|---|---|
| `tier` | `"free" \| "premium"` | Whether the plugin requires a paid plan. |
| `installed` | `boolean` | Whether the plugin is already installed for the requesting org (regardless of enabled state). |

The `authKind` field is always `"none"` and `transportTypes` is always `[]` for capability entries.

## Roles

Any authenticated org member (read-only). Owner/Admin required for all write operations.

## Surfaces

- `GET /api/v1/plugin/catalog/browse` (query params)
- MCP tool `plugin_catalog_browse`
