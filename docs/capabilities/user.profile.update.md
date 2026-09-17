# user.profile.update

The Account dialog's identity fields: display name and avatar. The rebuilt app has no write seam onto `auth.users` — its one `withSystemDb` read (`apps/app/src/server/tenancy-lookups.ts`) is column-gated to `id`/`twoFactorEnabled` — where the retired app wrote the row directly from a server action. Every write in the rebuilt app goes through `kernelWrite(contract)`, so the profile write became a real capability.

The input carries no user id: the handler acts on the authenticated principal only. A capability that took a target user id would be a privilege-escalation surface.

`auth.users` has no org_id/workspace_id and is not under RLS, and identity follows the person across organisations, so the capability is `scoped: false` and writes on the system executor, same reasoning as `set_preferences`.

## Mode

**sync**

## Surface

- API: `PATCH /v1/user/profile`
- MCP: none, deliberately — see below
- Authentication: session; the caller must carry a person (`forbidden` otherwise)
- Capability name: `update_profile`
- Not billed (`noBillingGate: true`): a settings write is never a governed action (ADR-052 exclusion 2).

### Why there is no MCP tool

The handler acts on `ctx.userId` and nothing else, and MCP has no user principal
to give it. `resolveMcpContext` (`apps/mcp/src/context.ts`) authenticates an API
key and builds its context with `userId: null`, and rejects a session token
outright — "there is no legitimate MCP use case for session-token auth". An
`update_profile` MCP tool could therefore only ever answer
`forbidden`/`no_principal`, so the capability does not declare the `mcp` surface
and no tool is advertised.

Resolving the acting user from the API key's creator instead (`resolveActingUserId`,
the attribution seam `workspace.create` and `agent.register` use) is the wrong
answer here rather than a shortcut: it would let a machine credential rewrite the
display name and avatar of the person who minted it, which is an impersonation
seam in the identity the fleet record and the audit log render. A person changes
their own name from a session — in the app, or over the API with a session
credential.

## Input

Both fields are required — this is a full replace of the identity fields, not a partial update.

| Field | Type | Required | Constraint |
|---|---|---|---|
| `displayName` | string | yes | trimmed, 1-120 characters |
| `avatarUrl` | string \| null | yes | an `https://` URL or a designed-avatar spec string (`avatar:v1:<json>`); `null` clears it |

## Output

The persisted values, read back from the row after the write.

| Field | Type | Description |
|---|---|---|
| `displayName` | string | the stored display name |
| `avatarUrl` | string \| null | the stored avatar value, or `null` when unset |
