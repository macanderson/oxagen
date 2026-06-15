# connection.mappings.get

**Domain:** connection
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Get the current entity type mappings for a data source connection.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| connectionId | string | Public ID or internal UUID of the connection |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| mappings | array of objects | Array of mapping configurations |

Each mapping object contains:
- id: string
- sourceRecordType: string (raw type from source)
- oxagenEntityType: string (target entity type)
- propertyMappings: object (field name mappings)
- isActive: boolean
- createdAt: string
- updatedAt: string

## Side effects

Read-only. Queries Postgres connection_mappings table.

## Errors

None explicitly defined in the contract.
