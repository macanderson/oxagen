# plugin.org.uninstall

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** destructive

## Intent

Soft-delete a plugin listing from the org allow-list and remove all dependent workspace installs (`agent.mcp_servers` rows). After uninstall the server's tools are no longer available to any agent in any workspace under this org.

## Input

| Field | Type | Notes |
|---|---|---|
| `orgListingId` | `string` | Public ID of the `plugin.org_listings` row to remove. |

## Output

| Field | Type | Notes |
|---|---|---|
| `ok` | `boolean` | `true` on success. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: soft-deletes the `plugin.org_listings` row (sets `deleted_at`).
- Postgres: deletes all `agent.mcp_servers` rows where `org_listing_id` matches.
- Postgres: deletes stored credentials for this listing from `plugin.credentials`.
- ClickHouse: emits `plugin.org.uninstalled` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/org/uninstall`
- MCP tool `plugin_org_uninstall`
