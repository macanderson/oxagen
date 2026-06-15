# connection.mappings.set

**Domain:** connection
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Save entity type mappings for a data source connection. Activates the
connection and starts ingestion once mappings are confirmed.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| connectionId | string | Public ID or internal UUID of the connection |
| mappings | array of objects | Confirmed entity type mappings (1+ items) |
| activateConnection | boolean | Set connection to active and queue sync (default: true) |

Each mapping object:
- sourceRecordType: string (raw type from source)
- oxagenEntityType: string (target entity type in snake_case)
- propertyMappings: object (source field → canonical property mappings, default: {}) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| mappingsCreated | number | Count of newly created mappings |
| mappingsUpdated | number | Count of updated mappings |
| connectionStatus | string | Updated connection status |

## Side effects

Creates or updates rows in Postgres connection_mappings table. If
activateConnection=true, sets connection status to "active" and queues Inngest
sync job. Triggers Neo4j ingestion if activated.

## Errors

None explicitly defined in the contract.
