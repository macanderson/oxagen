# billing.reseller_rebill.push

**Name:** `push_reseller_rebill`
**Domain:** billing
**Mode:** sync
**Scope:** tenant (org)

## Intent

Push a customer's priced usage for a period to the reseller's OWN Stripe account as an invoice, recording the run. Idempotent per (customer, period): a re-push updates the run and reuses the same invoice, never duplicating it. Returns `needsStripeConnection` when no key is connected (nothing pushed).

## Input

`customerId`, `start`, `end`, `finalize` (default true — open the invoice vs leave a draft).

## Output

`{ run, needsStripeConnection }` — the run carries status, provider invoice id, hosted URL, and line items.

## Side effects

- Postgres: reads/writes the org-scoped `billing.reseller_*` tables under row-level tenant isolation.
- ClickHouse: read-only aggregate over `token_usage` (via the shared usage-attribution query).
- Stripe: creates an invoice in the reseller's own connected account (via the vendor-neutral BillingProvider).
- Neo4j: none.

## Surfaces

- **API:** POST `/v1/:org/:ws/billing/revenue/rebill/push`
- **MCP:** tool `push_reseller_rebill`
- **App:** `/{org}/billing/revenue` — Revenue / Reseller page
