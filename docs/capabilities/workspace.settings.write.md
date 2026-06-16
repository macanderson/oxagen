# workspace.settings.write

**Domain:** workspace
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Update the active workspace's general settings (partial). Routes the settings
page edit through the capability kernel so the same fields are editable from the
agent, MCP, and CLI — every write runs through IAM, metering, and audit instead
of a page-local server action.

## Input

All fields optional — omit = leave unchanged, value = set, null = clear (description only).

| Field | Type | Notes |
| --- | --- | --- |
| name | string? | 1–120 chars |
| slug | string? | lowercase letters, numbers, single hyphens (unique within the org) |
| description | string \| null? | ≤2000 chars; stored in the settings bag |

## Output

The full workspace settings object (same shape as `workspace.settings.read`).

## Side effects

Updates `workspace.workspaces` for the active workspace. `description` is
merged into the `settings` JSONB bag (other settings keys are preserved).
ClickHouse observes the write via the kernel. A slug collision surfaces as a
clean "already in use" error rather than a raw unique-constraint violation.

## Errors

- Slug already in use by another workspace in the org.
- Requires a workspace context; throws when the workspace is not found.
