# user.profile.update

The Account dialog's identity fields: display name and avatar. The rebuilt app has no write seam onto `auth.users` — its one `withSystemDb` read (`apps/app/src/server/tenancy-lookups.ts`) is column-gated to `id`/`twoFactorEnabled` — where the retired app wrote the row directly from a server action. Every write in the rebuilt app goes through `kernelWrite(contract)`, so the profile write became a real capability.

The input carries no user id: the handler acts on the authenticated principal only. A capability that took a target user id would be a privilege-escalation surface.

`auth.users` has no org_id/workspace_id and is not under RLS, and identity follows the person across organisations, so the capability is `scoped: false` and writes on the system executor, same reasoning as `set_preferences`.

## Mode

**sync**

## Surface

- API: `PATCH /v1/user/profile`
- MCP: none. MCP authenticates with an API key and every MCP context carries `userId: null`, so a machine credential has no "own profile" to change; a tool here could only ever return `forbidden`/`no_principal`. The surface returns if MCP grows a session principal.
- Authentication: session; the caller must carry a person (`forbidden` otherwise)
- Capability name: `update_profile`
- Not billed (`noBillingGate: true`): a settings write is never a governed action (ADR-052 exclusion 2).

## Access

`defaultEffect: "allow"`, and every system role at each scope is granted
explicitly: org `Owner`, `Admin`, `Compliance`, `Billing`; workspace `Owner`,
`Member`, `Viewer`. A person is never the wrong person to be, so the only gate
is the handler's: no authenticated principal, no write.

The role map alone would not be enough. On an enterprise org — the only tier
that runs the IAM resolver, since `checkIAM` fast-paths every other tier to an
unconditional allow for a non-agent principal — a role the map omits gets no
seeded grant, and the four system org roles are Owner, Admin, **Compliance**
and **Billing** (there is no org-level `Member` or `Viewer`; those are
workspace roles). `defaultEffect: "allow"` is rule 8 of the resolver and is
role-agnostic, so a role added later cannot fall through it. An explicit denial
still wins: rule 7 evaluates role grants deny-first and hard-stops before rule 8
is reached.

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
