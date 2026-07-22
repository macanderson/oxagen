---
# Access

- **Route:** `/{orgSlug}/access` (tabs: Sessions · Reviews)
- **Nav location:** org → Governance → "Access" (Enterprise-gated section)
- **Priority:** P2
- **Disposition vs today:** Keep

## Purpose
Access is the org-wide session and periodic access-review surface, gated to Enterprise plans. It exists so a security manager can see and revoke live sessions across the org and run the quarterly access reviews that SOC 2 CC6 evidence requires, tying the identity link of the accountability chain to concrete, auditable review events.

## Primary user & jobs-to-be-done
- **Primary user:** Security manager (Enterprise org)
- **JTBD:**
  - See every active session across the org and who holds it.
  - Revoke a session immediately if a device is lost or an employee departs.
  - Run a quarterly access review: confirm each member still needs their current role, or revoke.
  - Produce evidence (CC6.1, CC6.3) that access reviews actually happened.

## Functionality
- **Sessions tab:** table of active Better Auth sessions — member, device/user-agent, IP, created/last-active, action (Revoke). Revoke gated to security managers only.
- **Reviews tab:** quarterly access-review snapshot — member, role, last-active date, actions (Confirm, Revoke). Review-completion action closes out the period and timestamps it.
- Layout-level gate: non-Enterprise orgs are redirected to org root before reaching either tab.

## Capabilities invoked
- No dedicated contract — direct DB reads/writes for sessions and review state, plus security-event emission (`security.session_revoked`, `access.member_access_confirmed`, `access.review_completed`).
- `org.member.remove` (`remove_org_member`) — invoked when a review action revokes a member's org access entirely.

## Data sources
Postgres (Better Auth session tables, access-review snapshot tables, security events).

## States
- **Empty:** Sessions tab empty only if no active sessions (unusual); Reviews tab shows "No review in progress — start one" if none is open.
- **Loading:** skeleton rows for sessions/review member lists.
- **Error:** revoke/confirm action failure shows inline row-level error; layout gate failure (plan check) redirects rather than erroring.

## Existing implementation
- **Today:** `access/sessions` is COMPLETE — org-wide Better Auth session manager, revoke gated to security managers, emits `security.session_revoked`, serves as CC6.1 evidence. `access/reviews` is COMPLETE — quarterly snapshot with members+role+last-active, Confirm/Revoke actions, emits `access.member_access_confirmed` / `org.member_removed` / `access.review_completed`, serves as CC6.3 evidence. Layout redirects non-Enterprise orgs to org root. Reuse as-is.

## Vision alignment
Combines the audit-record and identity links of the accountability chain into a periodic, provable review process — SOC 2 CC6 evidence is a concrete expression of the trust moat. P2 since it's Enterprise-gated and already complete.
