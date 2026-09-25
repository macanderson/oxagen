# start_mcp_authorization

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Start OAuth sign-in for an MCP server. The server is either a new provider,
from the registry or a custom endpoint, or a reconnect of one already added.
The app's Add a provider wizard opens the returned URL in a popup, so the
person never leaves the dialog.

The handler requires an org Owner or Admin, or a workspace Owner, and asserts
the role itself. A person authorizes a connection, never an agent.

## Input

| Field         | Type                         | Notes                                                        |
| ------------- | ---------------------------- | ------------------------------------------------------------ |
| `mcpServerId` | `string?`                    | Reconnect this provider (`mcs_…`).                           |
| `name`        | `string?` (1 – 120)          | Required with `endpointUrl` when adding.                     |
| `endpointUrl` | `string?` (URL)              | A public https streamable-http endpoint.                     |
| `description` | `string?`                    |                                                              |
| `iconUrl`     | `string?`                    | Kept only when https.                                        |
| `registryId`  | `string?`                    | The id the provider was picked from. Absent for a custom server. |
| `client`      | `{ clientId, clientSecret?, scopes? }?` | The workspace's own OAuth app, for a server that registers no clients (Slack, GitHub) or an internal one. |
| `redirectUrl` | `string` (URL)               | `<app origin>/api/v1/mcp/oauth/callback`, exactly.           |

## Output

A union on `status`:

| `status`          | Fields                                      | Meaning                                              |
| ----------------- | ------------------------------------------- | ---------------------------------------------------- |
| `redirect`        | `authorizationUrl`, `state`                 | Open the URL; the callback completes the flow.       |
| `authorized`      | `mcpServerId`, `healthStatus`, `discoveredTools` | A stored refresh token still worked.            |
| `client_required` | `scopesSupported`                           | Supply `client`: the server registers no clients.    |
| `not_oauth`       | none                                        | The endpoint asks for no OAuth. Use `register_mcp_server`. |

## Side effects

- Postgres: upserts a `plugin.installed_plugins` listing (`plugin_type = 'mcp_server'`, `auth_kind = 'oauth'`).
- Postgres: writes the OAuth client to `mcp.credentials`, with the secret envelope-encrypted, when one is supplied or registered.
- Postgres: stores the PKCE verifier and state in `auth.verifications` for 10 minutes.

## Errors

| code        | reason                           | meaning                                      |
| ----------- | -------------------------------- | -------------------------------------------- |
| `forbidden` | `org_role_required`              | The caller lacks the role.                   |
| `not_found` | `server_not_found`               | No OAuth provider under that id.             |
| `conflict`  | `endpoint_not_public`            | The endpoint is private or not https.        |
| `conflict`  | `redirect_url_invalid`           | The redirect URL is not the callback.        |
| `conflict`  | `provider_unnamed`               | Neither `mcpServerId` nor a name and endpoint. |
| `conflict`  | `authorization_discovery_failed` | The server's OAuth metadata could not be read. |
| `conflict`  | `authorization_failed`           | The authorization server refused to start.   |
