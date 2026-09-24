# authorize_mcp_server

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** medium

## Intent

Finish OAuth sign-in that `start_mcp_authorization` began. The app's
callback route, `/api/v1/mcp/oauth/callback`, calls it with the code the
authorization server returned. The handler exchanges the code, stores the
tokens, lists the server's tools and records the provider.

The saved flow state is bound to the workspace that started it. A state from
another workspace is answered as expired. The handler requires an org Owner or
Admin, or a workspace Owner.

## Input

| Field         | Type           | Notes                                           |
| ------------- | -------------- | ----------------------------------------------- |
| `state`       | `string`       | The `state` the start step returned.            |
| `code`        | `string`       | The authorization code.                         |
| `redirectUrl` | `string` (URL) | The same callback the flow was started with.    |

## Output

| Field             | Type                                       | Notes                                   |
| ----------------- | ------------------------------------------ | --------------------------------------- |
| `mcpServerId`     | `string`                                   | The provider's `mcs_…` id.              |
| `name`            | `string`                                   |                                         |
| `healthStatus`    | `"healthy" \| "degraded" \| "unreachable"` | The probe made with the new token.      |
| `discoveredTools` | `string[]`                                 | Names from `tools/list`.                |

## Side effects

- Postgres: writes the access and refresh tokens to `mcp.credentials`, envelope-encrypted, with `expires_at`. The refresh watcher and the runtime renew them from there.
- Postgres: upserts `mcp.mcp_servers` for the listing. A removed provider comes back.
- Postgres: pins each tool descriptor in `mcp.tool_snapshots`, and appends an `enable` row to `security.mcp_server_changes`.
- Postgres: deletes the single-use PKCE state, whether the exchange succeeded or not.

## Errors

| code        | reason                  | meaning                                         |
| ----------- | ----------------------- | ----------------------------------------------- |
| `forbidden` | `org_role_required`     | The caller lacks the role.                      |
| `not_found` | `authorization_expired` | The state expired or belongs to another workspace. |
| `not_found` | `server_not_found`      | The provider was removed mid-flow.              |
| `conflict`  | `authorization_failed`  | The authorization server refused the code.      |
| `conflict`  | `redirect_url_invalid`  | The redirect URL is not the callback.           |
