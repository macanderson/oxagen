# plugin.registry.list

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** low

## Intent

List MCP registries available to the org — the global default seed registry plus any org-added custom registries.

## Input

No input fields required.

## Output

| Field | Type | Notes |
|---|---|---|
| `registries[]` | `Registry[]` | List of registry summaries. |
| `registries[].id` | `string` | Public ID. |
| `registries[].name` | `string` | Display name. |
| `registries[].baseUrl` | `string` | Registry base URL. |
| `registries[].enabled` | `boolean` | Whether the registry is active for syncing. |
| `registries[].isDefaultSeed` | `boolean` | `true` for the platform-managed default registry. |
| `registries[].lastSyncedAt` | `string \| null` | ISO timestamp of the last successful sync. |

## Roles

Any authenticated org member (read-only).

## Surfaces

- `GET /api/v1/{org}/{ws}/plugins/registry/list`
- MCP tool `plugin_registry_list`
