# decline_member_invite

**Domain:** organization
**Mode:** sync
**Scope:** org
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Decline a pending org invitation. Marks the invitation as `declined` and frees the reserved license seat. The invitee or an org admin can decline. Declining is idempotent with respect to seat freeing — no membership is created, so there is nothing to remove.

## Input

| Field | Type | Notes |
|---|---|---|
| `invitationPublicId` | `string` (1+ chars) | Public ID of the invitation to decline. |

## Output

| Field | Type | Notes |
|---|---|---|
| `invitationPublicId` | `string` | Echo of the declined invitation's public ID. |
| `status` | `"declined"` | Always `"declined"` on success. |

## Roles

Org Owner, Admin, Member (authenticated users can decline invitations addressed to them; org admins can decline any pending invitation).

## Side effects

- Postgres: updates `org.invitations.status = 'declined'`; frees the reserved seat.
- ClickHouse: emits `org.invitation_declined` event.

## Surfaces

- `POST /api/v1/{org}/invitations/{invitationPublicId}/decline`
- MCP tool `org_member_invite_decline`
- Agent: no approval required, risk `low`.

## Errors

| code | meaning |
|---|---|
| `not_found` | Invitation does not exist. |
| `already_consumed` | Invitation has already been accepted or declined. |
| `unauthorized` | Caller is neither the invitation's target nor an org Admin/Owner. |

The handler verifies the acting user against the invitation email. A different recipient may decline only as an Owner or Admin of the invitation's own organization, with the invoking organization matching that target. The pending-state update is conditional, so a concurrent acceptance cannot be overwritten as declined.
