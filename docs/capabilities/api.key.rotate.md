# rotate_api_key

**Domain:** api_key
**Mode:** sync
**Scope:** tenant (org)
**Surfaces:** api, mcp, agent
**Risk level:** high

## Intent

Atomically issue a replacement API key and revoke the old one in a single
transaction. The replacement inherits the old key's scope, workspace, and expiry
(and its name, unless overridden). The raw replacement key is returned exactly
once and is never recoverable afterward. This is the missing rotation leg
alongside `api.key.create` and `api.key.revoke`.

**Authorization:** org Owner or Admin only.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| keyPublicId | string | The `aky_*` public ID of the key to rotate |
| name | string? | Optional new label (defaults to the old key's name) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| keyId | string | Internal UUID of the new key |
| publicId | string | `aky_*` public ID of the new key |
| name | string | Label of the new key |
| keyPrefix | string | Short prefix of the new key |
| rawKey | string | Full replacement key — shown ONCE |
| expiresAt | string \| null | Expiry inherited from the old key |
| createdAt | string | ISO-8601 creation timestamp |
| revokedKeyPublicId | string | Public ID of the now-revoked old key |
| revokedAt | string | ISO-8601 revocation timestamp |

## Side effects

In one transaction: inserts a new `api_keys` row and soft-deletes the old one
(scoped by org; IDOR-safe). Emits `api_key.created` + `api_key.revoked` security
events. The old key is invalid immediately after the call.

> **Follow-up:** an optional overlap window (old key valid for a grace period)
> would require the API-key resolver to honor a future-dated revocation; the
> current implementation revokes immediately.

## Server-owned credentials are refused

`auth.api_keys` also holds credentials the platform minted for something it
tracks elsewhere, and rotating those means more than minting a replacement row.
This capability refuses them and names the path that owns each one, matching
`api.key.create`, which refuses to mint them, and `api.key.revoke`, which
refuses to revoke them. The purpose is read from the stored `scope`, so the
caller cannot avoid the check by omitting it.

| `scope.purpose` | rotate it through |
|---|---|
| `tacho_host_v1` | operator re-enrollment |
| `agent_credential_v1` | `rotate_agent_credential` |
| `stella_operational_telemetry_v1` | operator re-enrollment |
| `cli_session_v1` | `oxagen login` |

`api.key.revoke` refuses only `tacho_host_v1` and `agent_credential_v1`, and the
asymmetry is deliberate. Rotation is for obtaining a fresh working credential,
and every path named above does that. None of them invalidates the old
credential, which is what revocation is for — so for `cli_session_v1` and
`stella_operational_telemetry_v1` those same paths pass rotate's test and fail
revoke's, leaving revoke as the only way to invalidate a leaked credential of
either kind. Rotating a CLI session here would also hand the new raw key back
through this capability's output, and nothing writes it into the operator's
config file, so the working credential would be revoked and replaced by one the
CLI never receives.

## Errors

- Only org Owners and Admins can rotate API keys.
- Throws `not_found` / `api_key_not_found` when the key does not exist, is not in this org, or is already revoked. `list_api_keys` returns revoked rows, so it reports those as not rotatable rather than leaving a surface to offer a rotation that cannot succeed.
- Throws `authz_denied` for a key an enrollment or a login flow owns — a Tacho host key, an agent credential, a Stella telemetry key, a CLI session key. That service owns the credential's lifecycle, and the message names which one.
- Throws `conflict` / `api_key_expired` for a key whose expiry has passed. Rotation copies the rotated key's `expires_at` onto the replacement, so rotating an expired key would revoke a key and mint one that is already expired, spending the single display of a secret nobody can use. The row is still present — `deleted_at` is null — so the not-found guard does not cover this.

All three key-side refusals and the `rotatable` field on `list_api_keys` are the same function, `packages/handlers/src/lib/api-key-rotatable.ts`, so a surface's control and this handler's answer cannot drift. A surface check is a courtesy against a value that can go stale; this refusal is the guarantee, and it is the same one on the API and MCP.
