# billing.reseller_customer.list

**Name:** `list_reseller_customers`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

List the org's reseller end-customer accounts (metadata only — usage and projected revenue come from `preview_reseller_rebill`).

## Input

`status` (`active`|`paused`, optional).

## Output

`{ customers }` — accounts with resolved price-plan name and status.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** GET `/v1/:org/:ws/billing/revenue/customers`
- **MCP:** tool `list_reseller_customers`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
