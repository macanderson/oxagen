# billing.reseller_customer.update

**Name:** `update_reseller_customer`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

Edit a customer account: rename, re-tag its external ref, assign/clear a price plan, or pause it (paused accounts are excluded from bulk pushes).

## Input

`id` (customer public id) + any of `name`, `externalRef`, `pricePlanId`, `status`.

## Output

`{ customer }` — the updated account.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** POST `/v1/:org/:ws/billing/revenue/customers/update`
- **MCP:** tool `update_reseller_customer`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
