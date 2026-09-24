# create_prepaid_invoice

**Capability:** `create_prepaid_invoice`
**Domain:** billing
**Mode:** sync
**Scope:** none (`scoped: false`; the call carries no tenant and the order is keyed on the input's `orgId`)
**Surfaces:** none
**Mutates:** yes
**Platform-operator only:** yes (`platformOnly: true`)
**Billing gate:** skipped (`noBillingGate: true`)

## Intent

Invoice an enterprise in advance (ADR-165). One order carries up to three lines, and at least one:

| Line | What it sells | Granted as |
|---|---|---|
| `licence` | the platform licence for a period | nothing; the line records the period paid for |
| `gau` | governed action units at the contracted rate | `purchased_gau` on the org's current bucket; purchased units carry into later months |
| `creditsCents` | usage credits for the in-app assistant, 1 credit = 1 cent | a `purchase` credit lot that never expires, reason `grant_prepaid_invoice` |

The invoice is a Stripe `send_invoice` invoice, due in `daysUntilDue` days. It prints the agreement and the PO number in its header, the memo above the lines, and a footer that points to statements. The lines read:

```
Oxagen platform licence (agreement MSA-2026-014): 1 Oct 2026 to 30 Sep 2027
Governed action units, prepaid: 2,000,000 GAU at $3.00 per 1,000
Usage credits for the in-app assistant, prepaid: $5,000.00 (500,000 credits)
```

The licence line carries its service period, which Stripe prints on the line.

## Reachability

`platformOnly: true`, `surfaces: []`, `defaultEffect: "deny"` with `defaultRoles: {}` (INV-31). `layers` lists `schema`, `unit` and `docs`.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `orgId` | string | yes | uuid |
| `orderId` | string | no | uuid; the resume key. Minted when left out |
| `agreementRef` | string | no | 1 to 140 characters; defaults to the org's negotiated agreement |
| `poNumber` | string | no | 1 to 140 characters |
| `currency` | string | no | ISO 4217, lower case; defaults to the org's contract currency |
| `licence` | object | no | `amountCents` (1 or more), `periodStart`, `periodEnd` (RFC 3339, half-open) |
| `gau` | object | no | `quantity` (1 or more), `ratePerGauMicros` (digits; defaults to the negotiated rate) |
| `creditsCents` | integer | no | 0 or more |
| `daysUntilDue` | integer | no | 0 to 365, default 30 |
| `grantOn` | enum | no | `paid` (default) or `issue` |
| `memo` | string | no | 1 to 500 characters |
| `assistantSpendCapCents` | integer or null | no | the org's monthly cap on platform-paid assistant tokens, set when the credits are granted; null removes the cap |

A `gau` line with no rate needs a negotiated agreement: a published tier's rate is not a contracted one, so the handler refuses the order with `gau_rate_required`. `gau.quantity × rate` must be a whole number of cents. An `assistantSpendCapCents` needs an order with credits.

## Output

`orderId`, `orgId`, `resumed`, `status`, `agreementRef`, `poNumber`, `currency`, `lines` (each with `kind`, `description`, `quantity`, `amountMicros`, `periodStart`, `periodEnd`), `totalMicros`, `stripeInvoiceId`, `invoiceNumber`, `hostedInvoiceUrl`, `invoicePdfUrl`, and `grant` (the issue-time grant, or null when the order grants on payment).

## Side effects

In order, each step retry-safe:

1. Insert the `billing.prepaid_orders` row as `draft`, `ON CONFLICT (id) DO NOTHING`. A re-run with the same `orderId` finds its row and must describe the same lines.
2. Create the Stripe invoice (`auto_advance: false`) and one item per line. Every request is keyed on the order id (`<orderId>:invoice`, `<orderId>:item:<line>`), and a row that already holds `stripe_invoice_id` skips the create.
3. Record `stripe_invoice_id`.
4. Check the draft's subtotal against the order's, then send it (`<orderId>:send`). A draft whose subtotal differs is never sent. An open invoice is only read, so a resume sends no second email.
5. Mark the order `open`.
6. For `grantOn: "issue"`, grant now (see `grantPrepaidOrder` below). Otherwise the webhook grants on `invoice.paid`.
7. Await a `billing.plan_changed` audit row.

The assistant cap instruction travels on the invoice metadata (`assistant_spend_cap_cents`: absent, `none`, or digits), because `prepaid_orders` has no column for it. The issue-time grant and the webhook grant both read it there.

### The grant (`grantPrepaidOrder`, `packages/billing/src/prepaid-orders.ts`)

One `withSystemDb` transaction under an advisory lock on the order:

- units, when `units_granted_at` is null: `ensureCurrentBucket(…, { purchasedDelta: gau_quantity })`, then `units_granted_at` and `granted_bucket_id`;
- credits, when `credits_granted_at` is null: `grantCreditLotOnce`, keyed `(grant_prepaid_invoice, prepaid_order, <orderId>)` on the ledger's `grant_%` unique index, then `credits_granted_at` and the assistant cap, if the invoice carries one;
- on payment: `status = 'paid'` and `paid_at`.

A second `invoice.paid`, or `invoice.paid` after an issue-time grant, grants nothing more. A paid invoice that is not the one the order records grants nothing and fails the webhook, so the error is recorded in `billing.stripe_event_processing`.

### Void and uncollectible

`invoice.voided` and `invoice.marked_uncollectible` set the order's status (`closePrepaidOrder`). A paid order stays paid. An order that granted at issue keeps its units and credits: nothing is clawed back automatically, and an error-level log names what stays granted so an operator can decide. An uncollectible invoice paid later is granted and marked paid.

## The one caller

```
pnpm billing:prepaid-invoice --org <slug> [--agreement <ref>] [--po <n>] \
  [--licence-usd <n> --licence-from <date> --licence-to <date>] [--gau <n> [--gau-rate-per-1000-usd <n>]] \
  [--credits-usd <n>] [--assistant-cap-usd <n|none>] [--days-until-due 30] [--grant-on paid|issue] \
  [--memo <text>] [--order-id <uuid>] [--dry-run]
```

`tools/scripts/billing-prepaid-invoice.ts`. The runbook is `docs/ops/enterprise-invoicing.md`.

## Errors

| code | meaning |
|---|---|
| `authz_denied` (`CapabilityError`) | the context carries no platform-operator binding, or one the kernel did not mint |
| `invalid_input` | a malformed field, or an order the table or the invoice cannot carry: `gau_not_whole_cents`, `gau_rate_required`, `cap_without_credits`, `empty_order`, and the rest the message names |
| `conflict` (`HandlerError`, 409) | `order_id_reused` (the `orderId` names different lines), `second_invoice`, or the order's invoice is `void` or `uncollectible` |
| `not_found` (`HandlerError`, 404) | no order with that id |
