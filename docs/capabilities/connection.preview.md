# connection.preview

**Domain:** connection
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Preview sample records from a data source connection. Used in the setup wizard
to show what data will be ingested.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| connectionId | string | Public ID or internal UUID of the connection |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| recordTypes | array of objects | Array of record type previews |

Each recordType object:
- sourceRecordType: string (raw record type from connector)
- displayName: string (human-readable label)
- description: string? (optional)
- sampleCount: number (total count of this type)
- sampleFields: array of strings (key field names observed)
- sampleRecords: array of objects (up to 3 sample records)

## Side effects

Read-only. Fetches sample records from the data source connector (may trigger
external API calls). Results cached during preview phase.

## Errors

None explicitly defined in the contract.
