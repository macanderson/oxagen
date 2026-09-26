# list_members

**File:** `workspace.member.list.ts` (dotted stem kept under the ADR-025 file-path realignment)
**Domain:** org
**Mode:** sync
**Scope:** tenant (org or workspace, chosen by the input)
**Surfaces:** api, mcp
**Risk level:** low
**Billing:** `noBillingGate: true` — a console read is never a governed action (ADR-052 exclusion 2)
**Mutates:** no

## Intent

List the members of the organization together with its pending invitations, or list the members of the workspace the request is scoped to. Backs the Organization › People page in `apps/app` (`scope: "org"`) and the existing API and MCP callers, which pass no scope and keep receiving the workspace listing.

Spec Appendix E names this tool `list_members`; it absorbs the former `list_workspace_members`, whose `workspace_id` input every surface ignored.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| scope | `"org" \| "workspace"` | Default `"workspace"`. `org` reads `org.org_users` and `org.invitations` for the request's org; `workspace` reads `workspace.workspace_users` for the request's workspace. |

## Output

A discriminated union on `scope`.

`scope: "org"`:

| Field | Type | Notes |
| --- | --- | --- |
| members[].id | string | The member's public user id (`usr_…`). |
| members[].name | string \| null | Display name; null when never set. |
| members[].avatarUrl | string \| null | An https URL or a designed `avatar:v1:` value; null when never set. A blank stored value reads as null. |
| members[].email | string | |
| members[].role | string | The stored org role, as written (both casings exist in rows). |
| members[].joinedAt | string | ISO 8601. |
| invitations[].id | string | The invitation's public id (`invi_…`). |
| invitations[].email | string | |
| invitations[].role | string | The org role granted on accept. |
| invitations[].invitedAt | string | ISO 8601. |
| invitations[].expiresAt | string \| null | ISO 8601; null for an invitation that never expires. |

Only `pending` invitations whose `expires_at` is null or in the future are returned. Members whose user is soft-deleted are not returned. Members are ordered by join date ascending, invitations by invitation date descending.

`scope: "workspace"`: `members[]` with the same shape, read from the workspace membership rows. No `invitations` key: invitations are org rows.

## Roles

Any member of the org (`defaultEffect: "allow"`), the way any member may list the orgs and workspaces they belong to. The tenant scope established by the surface bounds the read; the input cannot name another org or workspace.

## Side effects

None (read-only). Queries Postgres inside the tenant scope (`withTenantDb`, RLS plus explicit org and workspace predicates).

## Errors

None explicitly defined in the contract. A scope outside `org | workspace` is refused by the input schema.

Expired pending invitations remain in the organization read so an Owner or Admin can resend or revoke them. Expiry still prevents acceptance until a resend renews the invitation.
