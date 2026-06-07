# plugin.org.list

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List installed plugins (`org_listings`) and denylisted server names for the org. Optionally filter by plugin type. Returns full listing rows including enabled/disabled status, auth kind, and endpoint configuration — used by the marketplace UI to show what is installed and by agents enumerating available tools.

## Input

| Field | Type | Notes |
|---|---|---|
| `pluginType` | `"mcp_server" \| "integration" \| "content_tool"?` | Optional filter. Omit to return all types. |

## Output

| Field | Type | Notes |
|---|---|---|
| `listings` | `OrgListing[]` | Array of installed org plugin listings. |
| `listings[].id` | `string` | Internal row ID. |
| `listings[].publicId` | `string` | Public identifier. |
| `listings[].orgId` | `string` | Owning org ID. |
| `listings[].pluginType` | `string` | Type: `mcp_server`, `integration`, or `content_tool`. |
| `listings[].catalogServerId` | `string \| null` | Linked catalog entry, or null for custom servers. |
| `listings[].source` | `string` | `"catalog"` or `"custom"`. |
| `listings[].name` | `string` | Server name (reverse-DNS). |
| `listings[].title` | `string \| null` | Display title. |
| `listings[].description` | `string \| null` | Short description. |
| `listings[].iconUrl` | `string \| null` | Icon URL. |
| `listings[].endpointUrl` | `string \| null` | MCP endpoint URL (custom servers). |
| `listings[].transport` | `string \| null` | Transport type. |
| `listings[].authKind` | `string` | `"oauth"`, `"secret"`, or `"none"`. |
| `listings[].authConfig` | `Record<string, unknown>` | Auth configuration (no secrets). |
| `listings[].enabled` | `boolean` | Whether the listing is enabled for workspaces. |
| `listings[].config` | `Record<string, unknown>` | Additional configuration. |
| `denylist` | `DenylistEntry[]` | Array of denylisted server names for the org. |
| `denylist[].serverName` | `string` | Reverse-DNS server name on the denylist. |
| `denylist[].reason` | `string \| null` | Optional reason for denial. |

## Roles

Org Owner, Org Admin.

## Side effects

None — read-only.

## Surfaces

- `GET /api/v1/{org}/{ws}/plugins/org/list`
- MCP tool `plugin_org_list`
- Agent: no approval required, risk `low`.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller is not an org Owner or Admin. |
