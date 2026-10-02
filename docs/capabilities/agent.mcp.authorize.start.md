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

## Client identity

Oxagen presents itself to the authorization server in the first of these ways
the server accepts:

1. A client already stored for the provider: a workspace's own OAuth app, or
   one registered earlier.
2. A platform client configured for the server's host
   (`MCP_OAUTH_PREREGISTERED_CLIENTS`).
3. Oxagen's Client ID Metadata Document, when the server advertises
   `client_id_metadata_document_supported` and the callback is https. The
   client ID is `<app origin>/api/v1/mcp/oauth/client-metadata`, a public
   document the app serves that lists the callback. Nothing is registered.
4. Dynamic client registration (RFC 7591), when the server publishes a
   registration endpoint.

A server that accepts none of them answers `client_required`.

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
| `authorized`      | `mcpServerId`, `healthStatus`, `discoveredTools`, `steeringPr?` | A stored refresh token still worked. `steeringPr` is set when the server was proposed in a steering PR, as `authorize_mcp_server` describes. |
| `client_required` | `scopesSupported`                           | Supply `client`: the server takes neither a metadata document nor a registration. |
| `not_oauth`       | none                                        | The endpoint asks for no OAuth. Use `register_mcp_server`. |

## Side effects

- Postgres: upserts a `plugin.installed_plugins` listing (`plugin_type = 'mcp_server'`, `auth_kind = 'oauth'`).
- Postgres: writes the OAuth client to `mcp.credentials`, with the secret envelope-encrypted, when one is supplied or registered. A registered client also records its token endpoint auth method (`oauth_client_auth_method`), and the code exchange and every refresh authenticate with that method. A supplied client clears it.
- Postgres: stores the PKCE verifier and state in `auth.verifications` for 10 minutes.
- On `authorized`, records the server as `authorize_mcp_server` does, including a steering PR in a workspace whose tools live in its steering repo.

## Errors

| code        | reason                           | meaning                                      |
| ----------- | -------------------------------- | -------------------------------------------- |
| `forbidden` | `org_role_required`              | The caller lacks the role.                   |
| `not_found` | `server_not_found`               | No OAuth provider under that id.             |
| `conflict`  | `endpoint_not_public`            | The endpoint is private or not https.        |
| `conflict`  | `redirect_url_invalid`           | The redirect URL is not the callback.        |
| `conflict`  | `provider_unnamed`               | Neither `mcpServerId` nor a name and endpoint. |
| `conflict`  | `authorization_discovery_failed` | The server's OAuth metadata could not be read. |
| `conflict`  | `registration_refused`           | The server refused to register Oxagen as a client. |
| `conflict`  | `authorization_failed`           | The authorization server refused to start.   |
| `conflict`  | `steering_pr_open`               | On `authorized`: a steering PR that adds the server is already open. |
