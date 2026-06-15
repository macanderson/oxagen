# connection.delete

**Domain:** connection
**Mode:** async
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high

## Intent

Delete a data source connection. Supports three modes: connection_only (revoke
auth, keep data), data_only (delete Neo4j data, keep config), or full (delete
everything).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| connectionId | string | Public ID or internal UUID of the connection |
| mode | enum | Deletion mode: "connection_only", "data_only", or "full" (default: "full") |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| deletionJobId | string | Public ID of the deletion_jobs row tracking async progress |
| mode | enum | Deletion mode from input |
| status | literal | Always "running" initially |

## Side effects

Creates deletion_jobs record in Postgres. Queues async Inngest job for deletion.
Depending on mode: revokes auth credentials, deletes Neo4j graph data, or both.
ClickHouse records deletion event.

## Errors

None explicitly defined in the contract.
