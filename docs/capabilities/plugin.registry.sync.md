# plugin.registry.sync

**Domain:** plugin
**Mode:** async (returns accepted immediately)
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Trigger an on-demand catalog sync for a registry. The sync runs asynchronously via Inngest and updates the `mcp.catalog_servers` table with the latest server entries from the registry's API.

## Input

| Field | Type | Notes |
|---|---|---|
| `registryId` | `string` | Public ID of the registry to sync. |
| `mode` | `"full" \| "incremental"` | `"full"` rebuilds from scratch; `"incremental"` (default) fetches only changes since last sync. |

## Output

| Field | Type | Notes |
|---|---|---|
| `accepted` | `boolean` | `true` when the sync job was successfully enqueued. |

## Roles

Org Owner, Org Admin.

## Side effects

- Inngest: enqueues `plugin/registry.sync` job.
- Postgres: updates `mcp.registries.last_synced_at` on job completion.
- Postgres: upserts `mcp.catalog_servers` rows.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/registry/sync`
- MCP tool `plugin_registry_sync`
