# connection.create

**Domain:** connection
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Create a new data source connection for a workspace. Credentials are encrypted
before storage.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| connectorId | string | Connector type slug (e.g., 'github', 'google-drive') |
| displayName | string | Human-readable name (1-255 chars) |
| connectionConfig | object? | Connector-specific configuration (optional) |
| authCredential | object | Auth credential object — encrypted before storage |
| deliveryMethod | string? | Override delivery method (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| connectionId | string | Internal UUID of the source_connections row |
| publicId | string | con_* prefixed public ID |
| status | literal | Always "pending_setup" initially |
| connectorId | string | Connector type slug from input |
| displayName | string | Display name from input |

## Side effects

New row in Postgres source_connections table. Credentials encrypted at rest.
Connection starts in pending_setup status awaiting mappings confirmation.

## Errors

None explicitly defined in the contract.
