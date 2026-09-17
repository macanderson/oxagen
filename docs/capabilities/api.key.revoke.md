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

## Some server-owned credentials are refused

`auth.api_keys` also holds credentials the platform minted for something it
tracks elsewhere, and revoking those means more than soft-deleting the key. The
purpose is read from the stored `scope`, so the caller cannot avoid the check by
omitting it.

A refusal has to pass one test: **the path it names must achieve what the
refused operation was for.** Three of the four server-owned purposes pass it and
are refused. `cli_session_v1` does not, and is revocable here.

| `scope.purpose` | revoke it through | what a generic revoke would miss |
|---|---|---|
| `tacho_host_v1` | `revoke_tacho_enrollment` | the host row staying `active`, and the queued `revoke` control command a collector mid-poll needs |
| `agent_credential_v1` | `rotate_agent_credential`, `retire_agent` | the paired mint, or the agent's retirement — unpaired, the agent is live with no credential |
| `stella_operational_telemetry_v1` | operator revocation | no governed path exists yet; ingestion would end with nothing recording why |

### `cli_session_v1` is revocable here, deliberately

This is the only proportionate way to invalidate a lost or compromised CLI
credential. `oxagen login` only mints an additional key and never soft-deletes
the previous one; `oxagen logout` clears the local config file and makes no
server call; there is no session-scoped revoke route. Refusing it would leave
`remove_org_member` as the sole revocation path, which also strips the person's
organization access.

`api.key.rotate` does refuse it, and that asymmetry is correct: `oxagen login`
gives the operator a fresh working credential, which is what rotation is for. It
does not invalidate the old one, which is what revocation is for.

## Surfaces

- `DELETE /api/v1/{org}/{ws}/api-keys/{keyPublicId}`
- MCP tool `api_key_revoke` (requires approval)

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller is not an org Owner or Admin. |
| `authz_denied` | The key carries one of the three refused server-owned scope purposes; see above. |
| `not_found` | No key with the given public ID exists in this org. |
| `already_revoked` | Key has already been revoked. |
| `validation_error` | Input failed Zod parse. |
