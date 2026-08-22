# org.settings.write

**Domain:** organization
**Mode:** sync
**Scope:** tenant (org)
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Update the active organization's profile settings (partial). Routes the settings
page edit through the capability kernel so the same fields are editable from the
agent and MCP — every write runs through IAM, metering, and audit instead
of a page-local server action.

## Input

All fields optional — omit = leave unchanged, value = set, null = clear (nullable
profile fields only).

| Field | Type | Notes |
| --- | --- | --- |
| name | string? | 1–120 chars |
| slug | string? | lowercase letters, numbers, single hyphens |
| avatarUrl | string \| null? | URL, ≤2048 chars |
| website | string \| null? | URL, ≤2048 chars |
| industry | string \| null? | ≤120 chars |
| employeeSize | enum \| null? | Closed size range (`1`…`10000+`) |

## Output

The full org settings object (same shape as `org.settings.read`).

## Side effects

Updates `org.organizations` for the active org. ClickHouse observes the write
via the kernel. A slug collision surfaces as a clean "already in use" error
rather than a raw unique-constraint violation.

## Errors

- Slug already in use by another organization.
- Organization not found for the caller's org scope.
