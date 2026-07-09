# org.member.invite.accept

**Domain:** organization
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Accept a pending org invitation. Transitions the invitation to `accepted`, creates the `org_users` membership row, and provisions least-privilege IAM for the user. The handler validates that the authenticated user's identity matches the invitation's target email — an invitation cannot be accepted on behalf of another user.

## Input

| Field | Type | Notes |
|---|---|---|
| `invitationPublicId` | `string` (1+ chars) | Public ID of the invitation to accept. |

## Output

| Field | Type | Notes |
|---|---|---|
| `orgUserId` | `string` | ID of the created `org_users` row. |
| `orgId` | `string` | ID of the org the user has joined. |
| `role` | `string` | Org role assigned to the new member. |
| `joinedAt` | `string` | ISO-8601 timestamp of membership creation. |

## Roles

Org Owner, Admin, Member (any authenticated user can accept their own invitation; role check is identity-based, not role-based at time of accept).

## Side effects

- Postgres: updates `org.invitations.status = 'accepted'`; inserts `org.org_users` row; inserts `iam.principal_role_assignments` row.
- ClickHouse: emits `org.member_joined` event.

## Surfaces

- `POST /api/v1/{org}/invitations/{invitationPublicId}/accept`
- MCP tool `org_member_invite_accept`
- Agent: no approval required, risk `low`.

## Errors

| code | meaning |
|---|---|
| `not_found` | Invitation does not exist or has already been consumed. |
| `expired` | Invitation has passed its `expiresAt` timestamp. |
| `wrong_email` | Authenticated user's email does not match the invitation target. |
| `already_member` | User is already an active member of the org. |
