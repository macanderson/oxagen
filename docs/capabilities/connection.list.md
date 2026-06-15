# connection.list

**Domain:** connection
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List all data source connections for a workspace.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| status | enum? | Filter by status: "pending_setup", "active", "paused", "needs_reauth", "error", "deleted" (optional) |
| connectorId | string? | Filter by connector type slug (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| connections | array of objects | Array of connection summaries |

Each connection object contains:
- id: string (internal UUID)
- publicId: string (con_* prefixed)
- connectorId: string
- displayName: string
- authScheme: string
- deliveryMethod: string
- status: string
- entityCount: number
- lastSyncAt: string? (nullable)
- createdAt: string

## Side effects

Read-only. Queries Postgres source_connections table with optional filters.

## Errors

None explicitly defined in the contract.
