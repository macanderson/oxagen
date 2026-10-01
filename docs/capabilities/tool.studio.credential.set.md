# set_mcp_credential

**Capability:** `set_mcp_credential`
**Domain:** tool
**Mode:** sync
**Scope:** workspace
**Surfaces:** api, mcp
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`, storing a credential spends no model tokens)

## Intent

Your server.toml names a credential as `oxagen:credential/<name>`, and the environment needs a value behind that name before a tool call can authenticate. This capability stores that value in the workspace: a service secret, such as an API key, or the id and secret of an OAuth client. Calling it again with the same name replaces the value and keeps the credential's id, so an operator token issued against it stays linked.

Oxagen seals each secret with the credential vault key before it writes the row. The response names the credential and gives its reference. No response, log line, or audit event carries the secret.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `name` | string | yes | the `<name>` in `oxagen:credential/<name>`: up to 63 lowercase letters, digits, and hyphens, starting with a letter or digit |
| `kind` | string | yes | `secret` for a service secret, `oauth_client` for an OAuth client's id and secret |
| `secret` | string | for `secret` | the service secret, 1 to 8192 characters. Refused for `oauth_client` |
| `clientId` | string | for `oauth_client` | the OAuth client id, 1 to 512 characters. Refused for `secret` |
| `clientSecret` | string | for `oauth_client` | the OAuth client secret, 1 to 8192 characters. Refused for `secret` |

## Output

| Field | Type | Description |
|---|---|---|
| `name` | string | the credential's name |
| `reference` | string | `oxagen:credential/<name>`, as server.toml names it |
| `created` | boolean | true when this call created the credential, false when it replaced one |

## Roles

Org Owner or Admin, the roles `set_plugin_secret` grants. The handler checks the role with `assertOrgRole` (INV-29), because the kernel's IAM check does not enforce roles below the enterprise tier. An API key acts as the person who created it. An agent call needs approval (`requiresApproval: true`, risk `high`).

## Side effects

1. The handler checks the caller's role.
2. It seals the secret, or the OAuth client secret, with the credential vault key.
3. It writes one row to `mcp.credentials`, keyed on the workspace and the name. A new name inserts a row with status `active`. A name the workspace already holds updates that row in place: the new value replaces the old one, the other kind's columns are cleared, the stored access token, refresh token, scopes, and expiry are cleared, and the status returns to `active`.
4. It records a `plugin.credential_set` security event that names the capability and the acting user.

A name equal to a credential the workspace connected through a plugin replaces that credential too. The contract declares the credential (`mcp_credential`, by `name`) as its audit target.

## Surfaces

- `POST /v1/{org}/{ws}/tools/studio/credential`
- MCP tool `set_mcp_credential`

## Errors

| code | meaning |
|---|---|
| `forbidden` (403) | no signed-in user, or the caller is not an org Owner or Admin |
| `invalid_input` (400) | `name` does not match the pattern, `kind` is neither value, a field the kind needs is missing, a field the kind refuses is present, a value is empty or too long, or the input carries another field |
| `internal_error` (500) | the API has no credential vault key ([`AUTH_TOKEN_ENCRYPTION_KEY`](../../packages/config/src/registry.ts)), so it cannot seal the secret |
