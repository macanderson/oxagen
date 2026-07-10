# billing.reseller_customer.create

**Name:** `create_reseller_customer`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

Create a reseller end-customer account — the party a reseller invoices for observed agent usage, distinct from its own org membership. The first primitive of the re-bill loop.

## Input

`name` (string), `externalRef` (string, optional), `pricePlanId` (price-plan public id, optional).

## Output

`{ customer }` — the created account (public id, name, plan, status).

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** POST `/v1/:org/:ws/billing/revenue/customers`
- **MCP:** tool `create_reseller_customer`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
