---
# Members / People

- **Route:** `/{orgSlug}/members` (tabs: People · Invited)
- **Nav location:** org → People
- **Priority:** P1
- **Disposition vs today:** Keep

## Purpose
The Members page is the org's roster of principals — every user with a role in the org, plus everyone in the invitation pipeline. It is where an admin adds people, changes their role, removes them, and tracks pending invitations, making it the entry point for the identity link of the accountability chain: nothing downstream (permitted actions, billing attribution, audit records) means anything until a principal is bound to a role in an org.

## Primary user & jobs-to-be-done
- **Primary user:** Org admin / owner
- **JTBD:**
  - Invite a new teammate and assign them a starting role without exceeding seat limits.
  - See who has access today, at what role, and remove access when someone leaves.
  - Change a member's role as responsibilities change, without escalating past my own privilege.
  - Track outstanding invitations and resend or revoke them.
  - See current seat usage against the plan limit before inviting.

## Functionality
- **People tab:** table of `orgUsers ⋈ users` — columns: name/avatar, email, role, joined date, actions (change role, remove). Seat usage banner (used/limit) above the table. Invite button opens a modal: email, role selector (bounded by inviter's own role — no privilege escalation), disabled/blocked if seat limit reached.
- **Invited tab:** pending invitations list — columns: email, role, invited by, sent date, actions (Resend, Revoke). Live count badge on the tab showing pending invitation count.
- Role-gated controls: only owners/admins see invite/remove/role-change actions; regular members see read-only roster.

## Capabilities invoked
- `org.member.add` (`add_org_member`) — add a member to the org (post-invite acceptance or direct add).
- `org.member.remove` (`remove_org_member`) — revoke a member's org access.
- `org.member_role.change` (`change_member_role`) — change a member's role, bounded by caller's own role.
- `org.member_invite.accept` (`accept_member_invite`) — accept a pending invite (invitee-side).
- `org.member_invite.decline` (`decline_member_invite`) — decline a pending invite.
- `org.list` (`list_orgs`) — resolve orgs the current user belongs to (nav/context).

## Data sources
Postgres (`orgUsers`, `users`, invitation tables) + IAM role tables, via the capabilities above.

## States
- **Empty:** People tab never empty (creator is always a member); Invited tab shows "No pending invitations."
- **Loading:** skeleton rows for roster and invitation list while queries resolve.
- **Error:** inline banner on invite/role-change/remove failure (e.g. seat limit exceeded, privilege escalation blocked), roster remains visible.

## Existing implementation
- **Today:** `members/page.tsx` is COMPLETE — orgUsers⋈users roster, seat usage via `getOrgSeatUsage`, role-gated controls, invite flow enforces role-escalation and seat-limit guards. `members/pending` is COMPLETE — pending invitations with Resend/Revoke and a live count badge. Reuse as-is; no rebuild needed.

## Vision alignment
Membership + role is the first link of the accountability chain — every permitted action, billed event, and audit record traces back to a principal established here. P1 because nothing else in governance or billing attribution is meaningful without it.
