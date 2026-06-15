# form.submit

**Domain:** form
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Submit a response to a form.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| form_id | string | Form ID to submit response to |
| responses | object? | Form field responses as key-value pairs (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| submission_id | string | Unique submission identifier |
| status | string | Submission status |
| created_at | string | ISO 8601 submission timestamp |

## Side effects

New row created in Postgres form_submissions table. Responses persisted and
linked to form.

## Errors

None explicitly defined in the contract.
