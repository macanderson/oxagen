# billing.reseller_attribution_rule.delete

**Name:** `delete_reseller_attribution_rule`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

Delete an attribution rule (soft). Usage it matched becomes unattributed until another rule covers it.

## Input

`id` (rule public id).

## Output

`{ id, deleted: true }`.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** POST `/v1/:org/:ws/billing/revenue/attribution-rules/delete`
- **MCP:** tool `delete_reseller_attribution_rule`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
