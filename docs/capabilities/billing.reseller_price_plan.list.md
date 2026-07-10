# billing.reseller_price_plan.list

**Name:** `list_reseller_price_plans`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

List the org's reseller price plans.

## Input

none.

## Output

`{ pricePlans }`.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** GET `/v1/:org/:ws/billing/revenue/price-plans`
- **MCP:** tool `list_reseller_price_plans`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
