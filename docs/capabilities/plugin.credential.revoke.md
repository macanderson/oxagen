# plugin.credential.revoke

**Domain:** plugin
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Revoke and delete the stored credential (OAuth tokens or secret) for an installed plugin server in this workspace — the "Remove authentication" action. After revocation the workspace must re-authenticate (via OAuth or by setting a new secret) before the server can be used again.

## Input

| Field | Type | Notes |
|---|---|---|
| `orgListingId` | `string` | Public ID of the org listing whose credential is revoked. |

## Output

| Field | Type | Notes |
|---|---|---|
| `revoked` | `boolean` | `true` when a credential row was deleted; `false` when no credential existed for the listing. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: deletes the `mcp.credentials` row for the (workspace × org listing); the encrypted secret material is destroyed.
- ClickHouse: the kernel records the privileged invocation via the `capability.invoke_*` audit trail (no secret material is ever logged).

## Surfaces

- `POST /api/v1/{org}/{ws}/plugin/credential/revoke`
- MCP tool `revoke_plugin_credential`
