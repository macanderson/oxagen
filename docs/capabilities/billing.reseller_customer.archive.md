# billing.reseller_customer.archive

**Name:** `archive_reseller_customer`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

Soft-delete a customer account. Historical re-bill runs keep a resolvable name; the account drops out of lists and future pushes.

## Input

`id` (customer public id).

## Output

`{ id, archived: true }`.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** POST `/v1/:org/:ws/billing/revenue/customers/archive`
- **MCP:** tool `archive_reseller_customer`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
