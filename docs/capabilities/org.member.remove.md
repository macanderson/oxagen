# remove_org_member

**Domain:** organization
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp, agent
**Risk level:** high (requires approval)

## Intent

Permanently remove a member from the org. Their `org_users` row is deleted, `principal_role_assignments` are revoked, and their principal is soft-deleted. The action is irreversible — a new invitation is required to re-onboard. Removing the last org owner is blocked to prevent org lockout. Audited as `org.member_removed`.

Authorization is enforced via `principal_role_assignments` (not the legacy `org_users.role` string), mirroring the billing authz pattern.

## Input

| Field | Type | Notes |
|---|---|---|
| `targetUserId` | `string` (1+ chars) | UUID of the user to remove from the org. |

## Output

| Field | Type | Notes |
|---|---|---|
| `removed` | `boolean` | Always `true` on success. |
| `targetUserId` | `string` | Echo of the removed user's UUID. |
| `orgId` | `string` | ID of the org the user was removed from. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres, in one transaction through `removeOrgMemberInTx` (`packages/database/src/member-lifecycle.ts`, shared with SCIM deprovisioning and the SSO deny sign-in):
  - soft-deletes every `iam.principal_role_assignments` row for the user in this org, org-wide and workspace-scoped;
  - marks the user's `iam.principals` row deleted;
  - deletes the `org.org_users` row and the user's `workspace.workspace_users` rows in this org's workspaces;
  - soft-deletes the CLI session keys the user created in this org, with one `api_key.revoked` row each.
- The user's sessions are left alone: a session belongs to the person, and removal from one org does not sign them out of the others. A SCIM deprovision ends them.
- `security.security_events`: an `org.member_removed` row.

## Surfaces

- `DELETE /api/v1/{org}/{ws}/members/{targetUserId}`
- MCP tool `org_member_remove` (requires approval)
- Agent: requires approval, risk `high`, category `organization`.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller is not an org Owner or Admin. |
| `not_found` | No member with the given user ID exists in this org. |
| `last_owner` | Cannot remove the final org owner — would lock out the org. |
| `cannot_remove_self` | Owners cannot remove themselves (use org transfer). |
