# plugin.workspace.set_enabled

**Domain:** plugin
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Enable or disable a plugin server for this workspace. Enabling upserts an `agent.mcp_servers` row sourced from the org listing, making the server's tools available to agents in this workspace. Disabling sets the row to `enabled=false` without removing it (credentials are preserved).

## Input

| Field | Type | Notes |
|---|---|---|
| `orgListingId` | `string` | Public ID of the org listing to enable/disable for this workspace. |
| `enabled` | `boolean` | `true` to enable, `false` to disable. |

## Output

| Field | Type | Notes |
|---|---|---|
| `workspaceServerId` | `string \| null` | Public ID of the `agent.mcp_servers` row, or `null` when disabling a server that had no row. |

## Roles

Org Owner, Org Admin, Workspace Owner.

## Side effects

- Postgres: upserts `agent.mcp_servers` row (on enable) or updates `enabled=false` (on disable).
- A background health probe is triggered on enable to populate `health_status`.
- ClickHouse: emits `plugin.workspace.enabled_changed` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/workspace/set-enabled`
- MCP tool `plugin_workspace_set_enabled`
