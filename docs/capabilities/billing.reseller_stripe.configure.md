# billing.reseller_stripe.configure

**Name:** `configure_reseller_stripe`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

Store the reseller's own Stripe secret key (envelope-encrypted at rest via @oxagen/crypto) so re-bill pushes invoice from their account, not the platform's. Returns only a last-4 fingerprint, never the key. Highest sensitivity.

## Input

`secretKey` (sk_live_… / sk_test_…), `accountLabel` (optional).

## Output

`{ connected: true, accountLabel, keyLast4 }`.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- Neo4j: none.

## Surfaces

- **API:** POST `/v1/:org/:ws/billing/revenue/stripe/connect`
- **MCP:** tool `configure_reseller_stripe`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
