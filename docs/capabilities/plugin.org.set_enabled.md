# plugin.org.set_enabled

**Domain:** plugin
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Toggle the `enabled` flag on an org-level plugin listing. Only enabled org listings are surfaced to workspaces for activation.

## Input

| Field | Type | Notes |
|---|---|---|
| `orgListingId` | `string` | Public ID of the org listing to enable or disable. |
| `enabled` | `boolean` | `true` to enable, `false` to disable. |

## Output

| Field | Type | Notes |
|---|---|---|
| `ok` | `boolean` | `true` on success. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: updates `plugin.org_listings.enabled`.
- When disabling: also sets `agent.mcp_servers.enabled=false` for all workspace rows that source from this listing.
- ClickHouse: emits `plugin.org.enabled_changed` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/org/set-enabled`
- MCP tool `plugin_org_set_enabled`
