# billing.reseller_stripe.status

**Name:** `get_reseller_stripe_status`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

Report whether a reseller Stripe key is connected for the org, with its label and last-4 fingerprint. Drives the connect-your-account empty state. Never returns the key.

## Input

none.

## Output

`{ connected, accountLabel, keyLast4, updatedAt }`.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** GET `/v1/:org/:ws/billing/revenue/stripe/status`
- **MCP:** tool `get_reseller_stripe_status`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
