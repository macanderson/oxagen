# org.member.role.change

**Domain:** organization
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp, agent
**Risk level:** high (requires approval)

## Intent

Change a member's org role. Replaces the existing role in `principal_role_assignments` and updates the legacy `org_users.role` string so both surfaces stay consistent. Demoting the last org owner is blocked to prevent lockout. Audited as `org.role_changed`.

## Input

| Field | Type | Notes |
|---|---|---|
| `targetUserId` | `string` (1+ chars) | UUID of the user whose role should change. |
| `newRole` | `string` (1+ chars) | New org role name (e.g. `"Admin"`, `"Member"`, `"Billing"`, `"Compliance"`). Must match a system role for this org. |

## Output

| Field | Type | Notes |
|---|---|---|
| `changed` | `boolean` | Always `true` on success. |
| `targetUserId` | `string` | Echo of the targeted user's UUID. |
| `orgId` | `string` | ID of the org. |
| `previousRole` | `string \| null` | The role that was replaced, or null if none. |
| `newRole` | `string` | The role that was assigned. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: replaces `iam.principal_role_assignments` row for the user in this org; updates `org.org_users.role`.
- ClickHouse: emits `org.role_changed` audit event.

## Surfaces

- `PUT /api/v1/{org}/{ws}/members/{targetUserId}/role`
- MCP tool `org_member_role_change` (requires approval)
- Agent: requires approval, risk `high`, category `organization`.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller is not an org Owner or Admin. |
| `not_found` | No member with the given user ID exists in this org. |
| `invalid_role` | `newRole` does not match any system role for this org. |
| `last_owner` | Cannot demote the final org owner. |
