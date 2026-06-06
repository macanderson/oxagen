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
| `pluginType` | `"mcp_server" \| "integration" \| "content_tool"?` | Filter by plugin type. |
| `authKind` | `"oauth" \| "secret" \| "none"?` | Filter by authentication kind. |
| `categories` | `string[]?` | Filter to servers in any of these categories. |
| `limit` | `number?` | Max results per page (1–100, default 20). |
| `offset` | `number?` | Pagination offset. |

## Output

| Field | Type | Notes |
|---|---|---|
| `servers[]` | `CatalogSummary[]` | Array of catalog server summaries. |
| `total` | `number` | Total matching records (for pagination UI). |
| `nextOffset` | `number \| null` | Offset for the next page, or `null` if last page. |

## Roles

Any authenticated org member (read-only). Owner/Admin required for all write operations.

## Surfaces

- `GET /api/v1/plugin/catalog/browse` (query params)
- MCP tool `plugin_catalog_browse`
