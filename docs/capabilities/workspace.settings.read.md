# workspace.settings.read

**Domain:** workspace
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the active workspace's general settings — name, slug, and description.
Routes the workspace settings page read through the capability kernel so the same
data is reachable from the agent and MCP with consistent IAM + metering.

## Input

_None._

## Output

| Field | Type | Notes |
| --- | --- | --- |
| name | string | Workspace display name |
| slug | string | URL slug (unique within the org) |
| description | string \| null | Free-text description (stored in the settings bag) |
| avatarUrl | string \| null | `https://` URL or `avatar:v1:<json>` designed-avatar spec; `null` when unset |

## Side effects

None (read-only). ClickHouse observes the invocation via the kernel.

## Errors

- Requires a workspace context.
- Throws when the workspace is not found for the caller's scope.
