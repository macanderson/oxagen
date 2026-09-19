# authorize_cli

**Capability:** `authorize_cli`
**Domain:** auth
**Mode:** sync
**Scope:** org + workspace (the tenant scope the caller enters)
**Surfaces:** none (`surfaces: []`; invoked only by the app's kernel seam from the `/cli/authorize` consent page)
**Mutates:** yes
**Billing gate:** skipped (`noBillingGate: true`; issuing a credential is a settings write, never a governed action)

## Intent

Mint the single-use authorization code that completes a CLI login (RFC 8252 loopback + PKCE S256). The CLI opens the browser at the app's `/cli/authorize` page with its code challenge, loopback `redirect_uri` and `state`; the signed-in person picks an org and workspace and consents; this capability binds a fresh code to the approving user, that scope and its slugs, the challenge, the redirect target and the key label, and stores it for five minutes. The consent page sends the browser to the loopback listener with `code` and `state`, and the CLI exchanges the code with its verifier at `POST /v1/auth/cli/token` for an API key.

Consent needs a Better Auth browser session, so there is no API route and no MCP tool. The kernel enforces a contract's `surfaces` list only when a caller names its surface; the app's kernel seam passes none, which is how a contract with an empty list is reachable from the app alone.

## Input

| Field | Type | Notes |
|---|---|---|
| `codeChallenge` | `string` | Base64url SHA-256 of the CLI's PKCE `code_verifier`: exactly 43 unpadded base64url characters. |
| `codeChallengeMethod` | `"S256"` | The only accepted PKCE method; `plain` is refused by the schema. |
| `redirectUri` | `string` | The CLI's loopback listener, `http://127.0.0.1:<port>/…` (or `localhost`, `::1`). The handler refuses any other target as `invalid_input`; no code exists to leak. |
| `label` | `string` | 1–120 characters after trimming; the label of the API key the code will be exchanged for. |
| `state` | `string` | The CLI's CSRF token. The consent page echoes it on the loopback redirect; the invocation audit records it with the request. |

## Output

| Field | Type | Notes |
|---|---|---|
| `code` | `string` | The single-use authorization code. Valid for five minutes; redeemed once at `POST /v1/auth/cli/token`. |

## Roles

Org Owner, Org Admin, checked in the handler with `assertOrgRole` (`packages/iam/src/org-role.ts`). The kernel's IAM check allows every capability for a non-enterprise org, so the contract's `defaultRoles` is documentation there. A user session is required: an API-key principal cannot consent on a person's behalf.

## Side effects

Inserts one `auth.verifications` row under `cli_auth:<code>` with the bound scope, expiring after `CLI_AUTH_CODE_TTL_MS`. The kernel's `capability.invoke_*` audit records the invocation.

## Errors

| code | meaning |
|---|---|
| `forbidden` (`HandlerError`, reason `user_session_required`) | No user session on the context. |
| `forbidden` (`HandlerError`, reason `org_role_required`) | The user is not an org Owner or Admin. |
| `invalid_input` | `redirectUri` is not a loopback http URL with an explicit port. |
| `not_found` (`HandlerError`, reason `workspace_not_found`) | The workspace on the context is not in the org. |
