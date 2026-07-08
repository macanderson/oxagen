# set_plugin_enabled

**Domain:** plugin
**Mode:** sync
**Scope:** org / workspace (selected by the `scope` argument)
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Enable or disable a plugin listing. The `scope` argument selects the target:

- **`scope: "org"`** — toggle the `enabled` flag on the org's installed-plugin
  listing. Only enabled listings are surfaced to workspaces for activation.
- **`scope: "workspace"`** — enable or disable the plugin *server* for this
  workspace. Enabling upserts an `agent.mcp_servers` row sourced from the org
  listing (making the server's tools available to agents here); disabling sets
  that row to `enabled=false` without removing it (credentials preserved).

(ADR-025 §3: scope is an argument, not two separate capabilities. This capability
replaces the former `set_org_plugin_enabled` and `set_workspace_plugin_enabled`.)

## Input

| Field | Type | Notes |
|---|---|---|
| `scope` | `"org" \| "workspace"` | Selects the target of the toggle. |
| `orgListingId` | `string` | Public ID of the org listing to enable/disable. |
| `enabled` | `boolean` | `true` to enable, `false` to disable. |

## Output

| Field | Type | Notes |
|---|---|---|
| `ok` | `boolean` | `true` on success. |
| `workspaceServerId` | `string \| null` | Public ID of the upserted `agent.mcp_servers` row for `scope="workspace"` enables; `null` on workspace disable and always `null` for `scope="org"`. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Admin.

## Side effects

- `scope="org"`: updates `plugin.installed_plugins.enabled`. Emits a
  `plugin.enabled_changed` security event.
- `scope="workspace"`: upserts `agent.mcp_servers` (on enable) or sets
  `enabled=false` (on disable). A background health probe is triggered on enable
  to populate `health_status`. Emits a `plugin.enabled_changed` security event.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugin/set-enabled`
- MCP tool `set_plugin_enabled`
