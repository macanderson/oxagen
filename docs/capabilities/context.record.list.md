# context.record.list

**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, agent, mcp
**Risk level:** low
**Billing gate:** none (noBillingGate: true)

## Intent

List the steering context records registered in the active workspace, each with its lifecycle status (active / retired / superseded) and the number and checksum of its pinned active version. Useful for auditing what steers a workspace's agents, or syncing against a repository's `.stella/rules/` directory.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| status | `active` \| `retired` \| `superseded` (optional) | Only return records in this lifecycle status |
| limit | integer (1–200, default 50) | Maximum number of records to return |
| offset | integer (default 0) | Pagination offset — number of records to skip |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| records | array | Ordered by record id |
| records[].id | string | Public record ID (`ctr_…`) |
| records[].recordId | string | The record's stable id (slug) |
| records[].title | string | |
| records[].status | string | active \| retired \| superseded |
| records[].version | integer \| null | Active version number; null when none is pinned |
| records[].checksum | string \| null | SHA-256 hex over the active version's body |
| records[].updatedAt | string (ISO 8601) | |
| total | integer | Total records matching the filter (for pagination) |

## Side effects

None — read-only.

## Errors

- DB errors propagated as-is.
