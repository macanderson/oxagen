# plugin.catalog.get

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Get full detail for one catalog server entry, including rendered README HTML, packages list, remote endpoints, transport types, and auth kind.

## Input

| Field | Type | Notes |
|---|---|---|
| `catalogId` | `string` | Public ID of the catalog server entry (`mcat_` prefix). |

## Output

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Public ID. |
| `name` | `string` | Reverse-DNS server name. |
| `title` | `string \| null` | Human-readable title. |
| `description` | `string` | Short description. |
| `version` | `string` | Semver version string. |
| `transportTypes` | `string[]` | Supported transport types (e.g. `["streamable-http"]`). |
| `authKind` | `"oauth" \| "secret" \| "none"` | Authentication kind. |
| `categories` | `string[]` | Category tags. |
| `icons` | `Array<{ src: string }>` | Icon URLs. |
| `packages` | `unknown[]` | Package registry entries (npm, pypi, docker). |
| `remotes` | `Array<{ transportType?: string }>` | Remote endpoint descriptors. |
| `websiteUrl` | `string \| null` | Project homepage. |
| `readmeHtml` | `string \| null` | README rendered to sanitized HTML. |
| `status` | `string` | `"active"` or other registry status. |

## Roles

Any authenticated org member (read-only).

## Surfaces

- `GET /api/v1/plugin/catalog/get?catalogId={id}`
- MCP tool `plugin_catalog_get`
