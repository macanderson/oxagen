# plugin.credential.set_secret

**Domain:** plugin
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Store or update an encrypted credential (API key or bearer token) for a plugin server in this workspace. The secret is encrypted at rest (AES-256-GCM with KMS-managed keys) and is never returned in read responses.

## Input

| Field | Type | Notes |
|---|---|---|
| `orgListingId` | `string` | Public ID of the org listing this credential belongs to. |
| `secret` | `string` | The API key or bearer token value. Stored encrypted; never logged. |

## Output

| Field | Type | Notes |
|---|---|---|
| `credentialId` | `string` | Public ID of the stored credential row. |

## Roles

Org Owner, Org Admin, Workspace Owner.

## Side effects

- Postgres: upserts a row in `plugin.credentials` with encrypted `secret_ciphertext`.
- ClickHouse: emits `plugin.credential.set` event (value never included in telemetry).

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/credential/set-secret`
- MCP tool `plugin_credential_set_secret`
