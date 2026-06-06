# plugin.registry.add

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Add a custom MCP registry source for the org. The registry must implement the MCP Registry OpenAPI 2025-12-01 spec. After registration a catalog sync is scheduled automatically.

## Input

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | Display name for the registry (1–120 chars). |
| `baseUrl` | `string` | Base URL of the registry (must be a valid HTTPS URL). |

## Output

| Field | Type | Notes |
|---|---|---|
| `registryId` | `string` | Public ID of the created `mcp.registries` row. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: inserts `mcp.registries` row.
- Inngest: schedules an initial `plugin.registry.sync` job.
- ClickHouse: emits `plugin.registry.added` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/registry/add`
- MCP tool `plugin_registry_add`
