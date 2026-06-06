# plugin.registry.remove

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Remove an org-added MCP registry source. The global default seed registry cannot be removed. Servers sourced from the removed registry remain installed but will no longer receive catalog updates.

## Input

| Field | Type | Notes |
|---|---|---|
| `registryId` | `string` | Public ID of the registry to remove. |

## Output

| Field | Type | Notes |
|---|---|---|
| `ok` | `boolean` | `true` on success. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: deletes the `mcp.registries` row (if not `is_default_seed`).
- ClickHouse: emits `plugin.registry.removed` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/registry/remove`
- MCP tool `plugin_registry_remove`
