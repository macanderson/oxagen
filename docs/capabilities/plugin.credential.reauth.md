# plugin.credential.reauth

**Domain:** plugin
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Initiate or complete an OAuth re-authentication flow for a plugin server whose token has expired or been revoked. Returns a redirect URL for the authorization step, or stores the refreshed token if a refresh token is available.

## Input

| Field | Type | Notes |
|---|---|---|
| `orgListingId` | `string` | Public ID of the org listing requiring re-auth. |
| `code` | `string?` | OAuth authorization code (provided on callback from the authorization server). Omit to initiate the flow (returns a redirect URL). |
| `redirectUri` | `string?` | Redirect URI used in the authorization request. Required when `code` is provided. |

## Output

| Field | Type | Notes |
|---|---|---|
| `redirectUrl` | `string?` | Authorization URL to redirect the user to (when initiating the flow). |
| `ok` | `boolean?` | `true` when the token exchange completed successfully (when `code` is provided). |

## Roles

Org Owner, Org Admin, Workspace Owner.

## Side effects

- Postgres: updates `plugin.credentials` with refreshed token and new expiry on successful exchange.
- ClickHouse: emits `plugin.credential.reauth` event.
- When re-auth completes: updates `agent.mcp_servers.health_status` to trigger a fresh health probe.

## Surfaces

- `POST /api/v1/{org}/{ws}/plugins/credential/reauth`
- MCP tool `plugin_credential_reauth`
