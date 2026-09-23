# get_workspace_settings

**Domain:** workspace
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the active workspace's general settings — name, slug, and description.
Routes the workspace settings page read through the capability kernel so the same
data is reachable from the agent, MCP, and CLI with consistent IAM + metering.

## Input

_None._

## Output

| Field | Type | Notes |
| --- | --- | --- |
| name | string | Workspace display name |
| slug | string | URL slug (unique within the org) |
| description | string \| null | Free-text description (stored in the settings bag) |
| avatarUrl | string \| null | `https://` URL or `avatar:v1:<json>` designed-avatar spec; `null` when unset |
| consequenceRoles | Record<tag, OrgRole[]> | The effective consequence-role map for mandates (ADR-059 decision 1): every starter tag plus the workspace's own, with the org roles that may grant, change or revoke a mandate for it; the stored overrides applied over `DEFAULT_CONSEQUENCE_ROLES` |

## Side effects

None (read-only). ClickHouse observes the invocation via the kernel.

## Errors

- Requires a workspace context.
- Throws when the workspace is not found for the caller's scope.

`runEnrichmentEnabled` reports whether automatic Stella run names and summaries are enabled. It is true unless the workspace explicitly saved false. Recording and deterministic output evidence do not depend on it.
