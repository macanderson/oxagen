---
# Workspace Settings — General

- **Route:** `/{orgSlug}/{workspaceSlug}/settings/general`
- **Nav location:** workspace → Settings → tab "General" (sub-section: Members)
- **Priority:** P2
- **Disposition vs today:** Keep + fold in Members tab

## Purpose
The landing tab of Workspace Settings: workspace identity (name, slug, description) plus a read-only roster of who has access. It answers "what is this workspace and who's in it" before an admin drills into agent defaults, environments, or graph config elsewhere.

## Primary user & jobs-to-be-done
- **Primary user:** Workspace Owner/Admin (edit rights); Member/Viewer (read-only)
- **JTBD:**
  - Rename the workspace or fix its slug/description.
  - See workspace access at a glance: each member's workspace role + org role.
  - Jump to org-level membership management when a role needs to change.

## Functionality
Two tabs:
- **General:** form — `name` (text), `slug` (text, unique), `description` (textarea). One "Save changes" button, Owner/Admin-gated (disabled for others).
- **Members:** table — `Name/email`, `Workspace role` (badge), `Org role` (badge), `Joined`; "(you)" marker on the viewer's row. Footer link to `/{orgSlug}/members` for role changes/removal. No mutation controls today.

## Capabilities invoked
- `workspace.settings.read` (`get_workspace_settings`) — loads the General form.
- `workspace.settings.write` (`update_workspace_settings`) — saves it.
- `workspace.member.list` (`list_workspace_members`) — loads Members.
- `workspace.invite.send` (`send_workspace_invite`) — reserved for a future "invite" action, not yet on this page.
- **Contract gap:** no capability exists to mutate a workspace-scoped member role — that's documented-planned, not built. Members stays read-only until it lands.
- Reverse-parity note: `workspace.settings.*` omit `app` from `layers[]` even though this page invokes them — flag for correction alongside the redesign.

## Data sources
Postgres only — `workspaces`, `workspace_users`, `org_users`, `users` via tenant-scoped queries. No Neo4j/ClickHouse/blob.

## States
- **Empty:** Members shows "No members in this workspace yet." (practically unreachable).
- **Loading:** server-rendered; route-level `loading.tsx`.
- **Error:** General save surfaces an inline alert, never a raw throw; Members read failure should degrade to an inline notice (not yet handled — fix in place).

## Existing implementation
- **Today:** `settings/general/page.tsx` complete, tested, role-gated. `settings/members/page.tsx` partial — reads via a raw tenant-scoped query (not yet routed through `invoke`), fully read-only. Reuse both; merge into one tabbed shell.

## Vision alignment
Workspace identity/roster is the scoping unit every accountability-chain record (contract call, spend, audit entry) hangs off — foundational, not a wedge feature. P2: consolidation, not core-critical.
