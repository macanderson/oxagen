# revoke_api_key

**Domain:** api_key
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp, agent
**Risk level:** high

## Intent

Revoke an API key by its `aky_*` public ID. The key is soft-deleted (sets `deleted_at`) and immediately invalid for all subsequent requests — `resolveApiKey` filters on `isNull(deletedAt)`. The row is retained for audit. Audited as `api_key.revoked`.

This capability is on the `agent` surface. When an agent turn calls it, the call waits for a person to approve it (`requiresApproval: true`). The `api` and `mcp` surfaces do not read that flag. There, IAM limits the call to org Owner or Admin, the workspace's decision rules apply, and the handler refuses the server-owned credentials listed below. The billing gate does not apply (`noBillingGate: true`).

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
refused operation was for.** Being server-owned is not the test — all four
purposes are. Two pass and are refused; two do not, and stay revocable here.

| `scope.purpose` | refused? | why |
|---|---|---|
| `tacho_host_v1` | **yes** → `revoke_tacho_enrollment` | that path revokes, and more completely: it also marks the host row `revoked` and queues the `revoke` control command a collector mid-poll needs. A generic revoke leaves `tacho_hosts.status` reading `active`. |
| `agent_credential_v1` | **yes** → `rotate_agent_credential`, `retire_agent` | both revoke, paired with a fresh mint or the agent's retirement. Unpaired, the agent is live with no credential and nothing re-mints. |
| `stella_operational_telemetry_v1` | no | **there is no Stella revocation path.** `create_stella_enrollment` and `ingest_stella_operational_telemetry` are the only Stella capabilities, and enrollment writes nothing but `auth.api_keys` — no lifecycle row to leave inconsistent. The soft-delete here is the whole job. |
| `cli_session_v1` | no | `oxagen login` only mints an additional key and never soft-deletes the previous one; `oxagen logout` clears the local config file and makes no server call; there is no session-scoped revoke route. Refusing would leave `remove_org_member` as the sole revocation, which also strips the person's organization access. |

The last two are the only way to invalidate a leaked credential of their kind.
If a governed revocation path is built for either, move it into the refused set
then — and not before.

### Why `api.key.rotate` refuses all four and this does not

Rotation is for obtaining a *fresh working credential*, and every path rotate
names does that: `oxagen login` for a CLI session, enrollment for the other two.
None of them invalidates the old credential, which is what revocation is for —
so the same paths pass rotate's test and fail this one. The asymmetry is
deliberate, not drift.

## Surfaces

- `DELETE /v1/{org}/{workspace}/api-keys/revoke` with the body `{ "keyPublicId": "aky_..." }`
- MCP tool `revoke_api_key`, gated like the API route
- Agent tool `revoke_api_key`, which waits for a person's approval

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller is not an org Owner or Admin. |
| `authz_denied` | The key carries `tacho_host_v1` or `agent_credential_v1`; see above. |
| `not_found` | No key with the given public ID exists in this org. |
| `already_revoked` | Key has already been revoked. |
| `validation_error` | Input failed Zod parse. |
