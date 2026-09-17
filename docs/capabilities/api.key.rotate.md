# api.key.rotate

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

`api.key.revoke` does **not** refuse `cli_session_v1`, and the asymmetry is
deliberate: `oxagen login` gives the operator a fresh working credential, which
is what rotation is for, but it does not invalidate the old one, which is what
revocation is for. Rotating a CLI session here would also hand the new raw key
back through this capability's output, and nothing writes it into the
operator's config file — so the working credential would be revoked and
replaced by one the CLI never receives.

## Errors

- Only org Owners and Admins can rotate API keys.
- Throws when the key does not exist, is not in this org, or is already revoked.
- `authz_denied` when the key carries a server-owned scope purpose; see above.
