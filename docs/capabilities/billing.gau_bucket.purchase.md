# purchase_gau_bucket

**Domain:** billing
**Mode:** sync
**Scope:** tenant

## Intent

Buy governed action units (GAUs) in block quantities at the organisation's
contracted rate, through a Stripe Checkout Session (ADR-055 §6). The
billing page's "Buy governed action units" form, API callers and the MCP
tool (`purchase_gau_bucket`) reach it. An API-key call (every MCP call, and
an API call with a key) buys as the key's creator, bounded by the creator's
current org role (`resolveActingUserId`); a key with no recorded creator is
refused `forbidden / no_principal` before any read.

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/billing/gau-bucket/purchase`
- MCP: `purchase_gau_bucket`
- Authentication: session or API key; the handler requires org Owner or Billing of the signed-in user or the key's creator (`assertOrgRole`, INV-29) — the kernel's IAM check enforces `defaultRoles` for enterprise organisations only
- Capability name: `purchase_gau_bucket`
- Not billed (`noBillingGate: true`, INV-27); IAM default-deny; high sensitivity; agent surface requires approval

## Behaviour

The handler prices the purchase at submit time: `resolveContractTerms`
answers with the negotiated `billing.contract_terms` row when one is in
force, otherwise the published figures of the entitled plan (or the Free
plan), and `quantityGau / blockSizeGau` blocks are sold at
`ratePerGauMicros × blockSizeGau` each. A terms change between render and
submit therefore prices what Checkout shows, and Checkout shows the
authoritative figure. The session is created with one inline `price_data`
line, `invoice_creation` enabled (every block purchase is a Stripe
Invoice), and `payment_intent_data.setup_future_usage: "off_session"`, so
the card the customer enters is saved to the customer for the recorder's
auto top-up.

Nothing pending is written. The session's metadata (`oxagen_kind:
"gau_purchase"`, the org, the quantity, the block size, the rate and the
currency) is the whole record of the sale; the `checkout.session.completed`
webhook (`grantGauPurchaseForCheckout`) inserts the `checkout` settlement
as `paid`, keyed on the session id, adds the quantity to the month's
`purchased_gau`, clears any open auto top-up episode, and makes the
collected card the default payment method when the customer had none.

There is no tier gate and no saved-card check. A Free organisation that has
exhausted its monthly allowance and holds no card is offered this purchase:
it is the rev1 card-saving path of the Free-tier rule (spec §4.2, ADR-055
§6). The refusal for want of a card applies only to the recorder's auto
top-up.

Buying more is never a charge in itself (INV-27): the contract declares
`noBillingGate: true`, so an organisation whose bucket is empty can still
buy. The handler checks the caller's org role itself — Owner or Billing —
because the kernel's IAM check enforces `defaultRoles` for enterprise
organisations only (ARCHITECTURE.md §3.2, INV-29). The agent surface
requires approval (`agent.requiresApproval: true`).

## Input

| Field         | Type                                  | Notes                                                                                   |
| ------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `quantityGau` | `number` (positive integer ≤ 1,000,000) | Units to buy; a whole number of blocks at the contracted block size.                    |
| `successPath` | `string` (app-relative path)          | Where Checkout returns on success. One leading slash; no scheme, no `//`, no whitespace. |
| `cancelPath`  | `string` (app-relative path)          | Where Checkout returns on cancel. Same rules.                                            |

The handler prefixes both paths with `NEXT_PUBLIC_APP_URL`, so the return
can only be the app's own origin.

## Output

| Field          | Type                       | Notes                                              |
| -------------- | -------------------------- | -------------------------------------------------- |
| `checkoutUrl`  | `string` (URL)             | The Stripe-hosted Checkout page.                   |
| `quantityGau`  | `number` (positive integer) | As requested.                                      |
| `blockSizeGau` | `number` (positive integer) | The block size the purchase was measured against.  |
| `blocks`       | `number` (positive integer) | `quantityGau / blockSizeGau`.                      |

No money field: the page prints the total from `get_contract_rate`.

## Side effects

- Postgres: reads `billing.org_billing_settings` (mode), `billing.contract_terms` / `billing.subscriptions` / `billing.plans` (terms), `org.organizations`, and `iam.principals` / `iam.principal_role_assignments` / `iam.roles` for the role gate. Writes `billing.org_billing_settings.stripe_customer_id` on an organisation's first purchase (`ensureStripeCustomer`).
- Stripe: may create a Customer; creates a Checkout Session.
- Security event: `billing.checkout_initiated` with `capability: purchase_gau_bucket`.
- ClickHouse: none.
- Neo4j: none.

## Errors

| code             | meaning                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tenant_missing` | No active tenant on the request context.                                                                                                                     |
| `forbidden`      | `HandlerError` (403): no signed-in user and no API key with a live creator (`no_principal`), or the acting user (the signed-in user, or the key's creator) holds neither Owner nor Billing in the org (`org_role_required`).                       |
| `conflict`       | `HandlerError` (409), reason `invoice_billed`: the organisation is approved for invoice billing, where consumption is never capped and units are not bought. |
| `invalid_input`  | `quantityGau` is not a whole number of blocks at the contracted block size, or a return path is not app-relative.                                            |

## SPEC references

- ADR-055 §6 — two billing modes, the block purchase, the card saved by Checkout
- `docs/specs/governed-action-metering.md` §4.2 — the Free-tier rule of 2026-09-14
- `apps/app/ARCHITECTURE.md` §1.4, §3.9 items 6 and 11 — the purchase form and the Stripe objects
