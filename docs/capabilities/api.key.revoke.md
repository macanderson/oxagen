# api.key.revoke

**Domain:** api_key
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp, agent
**Risk level:** high

## Intent

Revoke an API key by its `aky_*` public ID. The key is soft-deleted (sets `deleted_at`) and immediately invalid for all subsequent requests — `resolveApiKey` filters on `isNull(deletedAt)`. The row is retained for audit. Audited as `api_key.revoked`.

This capability is not exposed on the agent surface by default (`surfaces` excludes `agent`). It requires explicit approval when invoked via MCP.

## Input

| Field | Type | Notes |
|---|---|---|
| `keyPublicId` | `string` (1+ chars) | The `aky_*` public ID of the API key to revoke. |

## Output

| Field | Type | Notes |
|---|---|---|
| `revoked` | `boolean` | Always `true` on success. |
| `keyPublicId` | `string` | Echo of the revoked key's public ID. |
| `revokedAt` | `string` | ISO-8601 timestamp of the revocation. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: soft-deletes the `auth.api_keys` row (sets `deleted_at`).
- ClickHouse: emits `api_key.revoked` audit event.

## Server-owned credentials are refused

`auth.api_keys` also holds credentials the platform minted for something it
tracks elsewhere, and revoking those means more than soft-deleting the key.
This capability refuses them and names the path that owns each one, matching
`api.key.create`, which refuses to mint them, and `api.key.rotate`, which
refuses to rotate them. The purpose is read from the stored `scope`, so the
caller cannot avoid the check by omitting it.

| `scope.purpose` | revoke it through | what a generic revoke would miss |
|---|---|---|
| `tacho_host_v1` | `revoke_tacho_enrollment` | the host row staying `active`, and the queued `revoke` control command a collector mid-poll needs |
| `agent_credential_v1` | `rotate_agent_credential`, `retire_agent` | the paired mint, or the agent's retirement — unpaired, the agent is live with no credential |
| `stella_operational_telemetry_v1` | operator revocation | no governed path exists yet; ingestion would end with nothing recording why |
| `cli_session_v1` | `oxagen login`, or `remove_org_member` | nothing structurally; refused for symmetry with rotate |

## Surfaces

- `DELETE /api/v1/{org}/{ws}/api-keys/{keyPublicId}`
- MCP tool `api_key_revoke` (requires approval)

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller is not an org Owner or Admin. |
| `authz_denied` | The key carries a server-owned scope purpose; see above. |
| `not_found` | No key with the given public ID exists in this org. |
| `already_revoked` | Key has already been revoked. |
| `validation_error` | Input failed Zod parse. |
