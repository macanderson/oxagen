# document.list

**Domain:** document
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

List documents in the workspace.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| workspace_id | string? | Workspace ID (optional; uses current workspace if omitted) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| documents | array of objects | Array of document summaries |

Each document object:
- id: string
- title: string
- created_at: string
- updated_at: string
- author: string

## Side effects

Read-only. Queries Postgres documents table scoped to workspace.

## Errors

None explicitly defined in the contract.
