# billing.reseller_rebill.preview

**Name:** `preview_reseller_rebill`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

Compute per-customer re-bill line items for a period: attribute the period's observed usage to customers via the attribution rules (over disjoint workspace×principal×capability slices), then price each slice with the customer's plan. Does NOT touch Stripe. Read-only, `noBillingGate`.

## Input

`start`, `end` (ISO 8601, `end > start`, ≤ 366 days), `customerId` (optional — omit for all active customers).

## Output

`{ range, previews[], unattributedCostCents }` — each preview carries priced line items, subtotal (raw cost) and total (billed).

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- ClickHouse: read-only aggregate over `token_usage` (via the shared usage-attribution query).
- Neo4j: none.

## Surfaces

- **API:** POST `/v1/:org/:ws/billing/revenue/rebill/preview`
- **MCP:** tool `preview_reseller_rebill`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
