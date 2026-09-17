# user.profile.update

The Account dialog's identity fields: display name and avatar. The rebuilt app has no write seam onto `auth.users` — its one `withSystemDb` read (`apps/app/src/server/tenancy-lookups.ts`) is column-gated to `id`/`twoFactorEnabled` — where the retired app wrote the row directly from a server action. Every write in the rebuilt app goes through `kernelWrite(contract)`, so the profile write became a real capability.

The input carries no user id: the handler acts on the authenticated principal only. A capability that took a target user id would be a privilege-escalation surface.

`auth.users` has no org_id/workspace_id and is not under RLS, and identity follows the person across organisations, so the capability is `scoped: false` and writes on the system executor, same reasoning as `set_preferences`.

## Mode

**sync**

## Surface

- API: `PATCH /v1/user/profile`
- MCP: `update_profile`
- Authentication: session; the caller must carry a person (`forbidden` otherwise)
- Capability name: `update_profile`
- Not billed (`noBillingGate: true`): a settings write is never a governed action (ADR-052 exclusion 2).

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
