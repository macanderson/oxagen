# workspace.settings.write

**Domain:** workspace
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Update a workspace's general settings — name, slug, description, and avatar —
as a **partial** update: omit a field to leave it unchanged, pass a value to
set it, pass `null` (description and avatarUrl only) to clear it. The target
is the active workspace, or the one `workspaceId` names in the organization
(the Organization › Workspaces section edits from an org scope). Routes the
workspace settings edit through the capability kernel so the same fields are
reachable from the agent, MCP, and CLI with consistent audit.

Org Owners and Admins, and the Owner or Admin of the workspace the call is
scoped to, are checked in the handler (`assertOrgRole`, INV-29). `noBillingGate`:
a settings write, never a governed action (ADR-052 exclusion 2).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| workspaceId | string (`wrk_…`), optional | The workspace to update; omitted, the workspace the call is scoped to |
| name | string (1–120, trimmed), optional | New display name |
| slug | string (1–100, kebab-case), optional | New URL slug; must be unique within the org |
| description | string (≤2000) \| null, optional | Free-text description; `null` clears it |
| avatarUrl | string \| null, optional | `https://` URL or an `avatar:v1:<json>` designed-avatar spec; `null` clears the avatar (mirrors org.settings.write) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| name | string | Workspace display name after the update |
| slug | string | URL slug after the update |
| description | string \| null | Description after the update |
| avatarUrl | string \| null | Avatar after the update; `null` when unset |

## Side effects

Persists the changed fields to Postgres (workspace row + settings bag).
ClickHouse observes the invocation via the kernel; the change is audit-logged.

## Errors

| code | reason | when |
| --- | --- | --- |
| `forbidden` | `no_principal` / `org_role_required` | no signed-in user, or a user outside the accepted roles |
| `not_found` | `workspace_not_found` | no workspace with that public id in the org, or the active one is not in the org |
| `conflict` | `slug_taken` | the slug is already used by another workspace in the org |
| `invalid_input` | — | the slug fails the contract's validator (kernel) |
