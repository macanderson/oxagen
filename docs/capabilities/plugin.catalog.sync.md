# plugin.catalog.sync

**Domain:** plugin
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp

## Intent

Trigger an immediate sync of the MCP registry catalog for the workspace. Refreshes the locally-cached server listings from the upstream registry, either incrementally (using the stored cursor) or as a full re-sync.

## Input

| Field | Type | Notes |
|---|---|---|
| `fullSync` | `boolean` | Force a full re-sync, ignoring the stored cursor. Default `false` (incremental). |

## Output

| Field | Type | Notes |
|---|---|---|
| `total` | `number` | Total servers processed in this sync. |
| `succeeded` | `number` | Servers synced successfully. |
| `failed` | `number` | Servers that failed to sync. |
| `totalEntries` | `number` | Total cached catalog entries after the sync. |
| `durationMs` | `number` | Sync duration in milliseconds. |

## Roles

Org Owner, Org Admin, Workspace Owner.

## Side effects

- Refreshes the workspace's cached MCP registry listings from the upstream registry (Postgres) and advances the stored sync cursor.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller lacks the required org/workspace role. |
| `upstream_error` | The upstream registry could not be reached or returned an error. |
