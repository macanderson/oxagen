# document.create

**Domain:** document
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Create a new document in the workspace.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| title | string | Document title (required, non-empty) |
| content | string? | Document content (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| document_id | string | Unique document identifier |
| title | string | Document title from input |
| created_at | string | ISO 8601 creation timestamp |
| workspace_id | string | Workspace ID this document belongs to |

## Side effects

New row created in Postgres documents table. Document scoped to current workspace.

## Errors

None explicitly defined in the contract.
