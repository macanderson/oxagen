# api.key.revoke

**Domain:** api_key
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp
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

- Postgres: soft-deletes the `org.api_keys` row (sets `deleted_at`).
- ClickHouse: emits `api_key.revoked` audit event.

## Surfaces

- `DELETE /api/v1/{org}/{ws}/api-keys/{keyPublicId}`
- MCP tool `api_key_revoke` (requires approval)

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller is not an org Owner or Admin. |
| `not_found` | No key with the given public ID exists in this org. |
| `already_revoked` | Key has already been revoked. |
| `validation_error` | Input failed Zod parse. |
