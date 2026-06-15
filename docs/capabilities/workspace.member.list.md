# workspace.member.list

**Domain:** workspace
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

List members of a workspace.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| workspace_id | string? | Workspace ID (optional; uses current workspace if omitted) |

## Output

Array of member objects with:
- id: string (member ID)
- email: string (member email)
- role: string (role name: Owner, Admin, Member)
- joined_at: string (ISO 8601 timestamp)

## Side effects

Read-only. Queries Postgres workspace_members table (with RLS).

## Errors

None explicitly defined in the contract.
