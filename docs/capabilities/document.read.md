# document.read

**Domain:** document
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Read a document by ID — returns title, content, and metadata.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| document_id | string | Document ID to retrieve |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| title | string | Document title |
| content | string | Full document content |
| metadata | object | Document metadata as key-value pairs |
| created_at | string | ISO 8601 creation timestamp |

## Side effects

Read-only. Queries Postgres documents table.

## Errors

None explicitly defined in the contract.
