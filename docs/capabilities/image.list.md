# image.list

**Domain:** image
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

List images in the workspace.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| workspace_id | string? | Workspace ID (optional; uses current workspace if omitted) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| images | array of objects | Array of image summaries |

Each image object:
- id: string
- url: string
- created_at: string
- prompt: string

## Side effects

Read-only. Queries Postgres content.generated_assets table scoped to workspace.

## Errors

None explicitly defined in the contract.
