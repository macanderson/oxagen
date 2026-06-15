# form.create

**Domain:** form
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Create a new form with optional field definitions.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| title | string | Form title (required, non-empty) |
| fields | array? | Field definitions (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| form_id | string | Unique form identifier |
| title | string | Form title from input |
| created_at | string | ISO 8601 creation timestamp |

## Side effects

New row created in Postgres forms table. Form scoped to current workspace.

## Errors

None explicitly defined in the contract.
