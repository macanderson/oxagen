# suggest_connection_mappings

**Domain:** connection
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Use an LLM to suggest entity type mappings for a connection based on previewed
record types. Part of the setup wizard flow.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| connectionId | string | Public ID or internal UUID of the connection |
| recordTypes | array of objects | Record type samples to analyze (from connection.preview output) |
| existingEntityTypes | array of strings? | Entity types already in workspace (helps LLM reuse) (optional) |

Each recordType object:
- sourceRecordType: string
- displayName: string
- description: string? (optional)
- sampleFields: array of strings
- sampleRecords: array of objects? (optional)

## Output

| Field | Type | Notes |
| --- | --- | --- |
| suggestions | array of objects | LLM-generated mapping suggestions |
| suggestionIds | array of strings | Public IDs of persisted setup_suggestions rows |

Each suggestion object:
- sourceRecordType: string
- suggestedEntityType: string (snake_case)
- suggestedPropertyMappings: object (field mappings)
- confidence: number (0.0-1.0)
- reasoning: string (explanation shown in UI)

## Roles

An org Owner or Admin, or the workspace Owner. The handler checks the contract's roles and refuses anyone else with `forbidden` (`org_role_required`).

## Side effects

LLM call for suggestion generation (ClickHouse telemetry). Creates
setup_suggestions records in Postgres. Suggestions persist as draft for user
review.

## Errors

None explicitly defined in the contract.
