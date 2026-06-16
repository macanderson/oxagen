# connection.pause

**Domain:** connection
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Pause or resume syncing for a data source connection. Pausing stops further
ingestion while keeping the connection and its data intact; resuming returns it
to `connected`. Only valid for connections that are currently `connected` or
`paused` (not `pending_setup` / `error`).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| connectionId | string | Public ID (`con_*`) or internal UUID |
| paused | boolean | `true` = pause syncing; `false` = resume |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| connectionId | string | The connection |
| status | enum | Resulting status: `connected` or `paused` |

## Side effects

Toggles `source_connections.status` between `connected` and `paused` (org +
workspace scoped). ClickHouse observes the write via the kernel.

## Errors

- 409 when the connection is `pending_setup` or `error` (cannot be paused/resumed).
- 404 when the connection does not exist in the caller's org + workspace.
