# billing.reseller_price_plan.create

**Name:** `create_reseller_price_plan`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

Create a price plan: a markup over raw metered cost (basis points) or a flat per-unit price (cents). The margin layer applied to attributed usage.

## Input

`name`, `pricingMode` (`markup`|`per_unit`), `markupBps` (required for markup), `unitPriceCents` (required for per_unit), `currency` (default `usd`).

## Output

`{ pricePlan }`.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** POST `/v1/:org/:ws/billing/revenue/price-plans`
- **MCP:** tool `create_reseller_price_plan`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
