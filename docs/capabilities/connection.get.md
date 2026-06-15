# connection.get

**Domain:** connection
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Get details of a single data source connection.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| connectionId | string | Public ID or internal UUID of the connection |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| id | string | Internal connection UUID |
| publicId | string | con_* prefixed public ID |
| connectorId | string | Connector type slug |
| displayName | string | Human-readable connection name |
| authScheme | string | Auth scheme (e.g., "oauth2", "api_key") |
| deliveryMethod | string | How data is delivered (e.g., "webhook", "poll") |
| deliveryConfig | object? | Delivery configuration (nullable) |
| status | string | Current status: "pending_setup", "active", "paused", "needs_reauth", "error", "deleted" |
| entityCount | number | Number of entities ingested |
| lastSyncAt | string? | ISO 8601 timestamp of last sync (nullable) |
| errorMessage | string? | Error message if status is "error" (nullable) |
| createdAt | string | ISO 8601 creation timestamp |
| updatedAt | string | ISO 8601 last update timestamp |

## Side effects

Read-only. Queries Postgres source_connections table.

## Errors

None explicitly defined in the contract.
