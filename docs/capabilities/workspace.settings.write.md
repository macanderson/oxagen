# workspace.settings.write

**Domain:** workspace
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Update the active workspace's general settings — name, slug, description, and
avatar — as a **partial** update: omit a field to leave it unchanged, pass a
value to set it, pass `null` (description and avatarUrl only) to clear it.
Routes the workspace settings edit through the capability kernel so the same
fields are reachable from the agent and MCP with consistent IAM,
metering, and audit.

Allowed for org/workspace Owners and Admins only (`defaultEffect: deny`).

## Input

| Field | Type | Notes |
| --- | --- | --- |
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

- Requires a workspace context.
- Denied for non-admin members (IAM `defaultEffect: deny`; org/workspace Owner
  or Admin required).
- Rejects an invalid or duplicate slug.
