# billing.reseller_price_plan.update

**Name:** `update_reseller_price_plan`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

Update a price plan's name, mode, or rate. The mode↔rate invariant is enforced (markup→markupBps, per_unit→unitPriceCents).

## Input

`id` (plan public id) + any of `name`, `pricingMode`, `markupBps`, `unitPriceCents`, `currency`.

## Output

`{ pricePlan }`.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** POST `/v1/:org/:ws/billing/revenue/price-plans/update`
- **MCP:** tool `update_reseller_price_plan`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
