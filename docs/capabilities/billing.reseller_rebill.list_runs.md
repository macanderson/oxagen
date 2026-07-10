# billing.reseller_rebill.list_runs

**Name:** `list_reseller_rebill_runs`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

List past re-bill runs (period, subtotal, billed total, Stripe invoice, status, line items), most recent first — the historical per-customer usage→revenue view.

## Input

`customerId` (optional filter), `limit` (1–200, default 50).

## Output

`{ runs }`.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** GET `/v1/:org/:ws/billing/revenue/rebill/runs`
- **MCP:** tool `list_reseller_rebill_runs`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
