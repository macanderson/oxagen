# org.settings.read

**Domain:** organization
**Mode:** sync
**Scope:** tenant (org)
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the active organization's profile settings — name, slug, avatar, website,
industry, employee size, and type. Routes the org settings page read through the
capability kernel so the same data is reachable from the agent and MCP
with consistent IAM + metering.

## Input

_None._

## Output

| Field | Type | Notes |
| --- | --- | --- |
| name | string | Organization display name |
| slug | string | URL slug (first path segment) |
| avatarUrl | string \| null | Logo/avatar blob URL; null until uploaded |
| website | string \| null | Business website |
| industry | string \| null | Business industry |
| employeeSize | enum \| null | Closed size range (`1`…`10000+`) or null |
| type | enum | `personal` or `business` |

## Side effects

None (read-only). ClickHouse observes the invocation via the kernel.

## Errors

- Throws when the organization is not found for the caller's org scope.
