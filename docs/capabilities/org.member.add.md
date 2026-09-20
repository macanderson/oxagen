# add_org_member

**Domain:** organization
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp, agent
**Risk level:** medium (requires approval)

## Intent

Invite someone to join the org by email. Seat enforcement locks the organization and its subscription, checks capacity, and inserts the invitation in one transaction. Two concurrent invitations cannot reserve the final seat. An organization with no subscription uses the same organization lock. If no license is available, the call fails with a typed `SeatLimitError`. The invitation is created in `pending` state and must be accepted by the invitee via `org.member.invite.accept`.

## Input

| Field | Type | Notes |
|---|---|---|
| `email` | `string` (valid email) | Email address of the user to invite. |
| `role` | `string` (1+ chars) | Org role to assign on acceptance (e.g. `"Member"`, `"Admin"`). Must match a system role for this org. |

## Output

| Field | Type | Notes |
|---|---|---|
| `invitationId` | `string` | Internal ID of the created invitation. |
| `email` | `string` | Echo of the invited email address. |
| `role` | `string` | Org role that will be assigned on acceptance. |
| `status` | `"pending"` | Always `"pending"` on creation. |
| `expiresAt` | `string \| null` | ISO-8601 expiry of the invitation, or null if no expiry. |

## Roles

Org Owner, Org Admin.

## Side effects

- Postgres: inserts `org.invitations` row with `status = 'pending'`; reserves a license seat.
- Email: sends invitation email to the provided address.
- ClickHouse: emits `org.member_invited` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/members/invite`
- MCP tool `org_member_add` (requires approval)
- Agent: requires approval, risk `medium`, category `organization`.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller is not an org Owner or Admin. |
| `seat_limit_exceeded` | Org has no available license seats. |
| `already_member` | User is already an active member of the org. |
| `invitation_pending` | An active invitation for this email already exists. |
| `validation_error` | Input failed Zod parse. |
