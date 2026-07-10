# billing.reseller_attribution_rule.list

**Name:** `list_reseller_attribution_rules`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

List the org's attribution rules in evaluation order (priority ascending), each resolved to its customer name.

## Input

`customerId` (optional filter).

## Output

`{ rules }`.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** GET `/v1/:org/:ws/billing/revenue/attribution-rules`
- **MCP:** tool `list_reseller_attribution_rules`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
