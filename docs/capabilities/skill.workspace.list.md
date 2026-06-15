# skill.workspace.list

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

List skills available in the workspace.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| workspace_id | string? | Workspace ID (optional; uses current workspace if omitted) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| skills | array of objects | Array of available skill definitions |

Each skill object:
- id: string
- name: string
- description: string
- enabled: boolean

## Side effects

Read-only. Queries Postgres workspace_skills table (or agent skill registry).

## Errors

None explicitly defined in the contract.
