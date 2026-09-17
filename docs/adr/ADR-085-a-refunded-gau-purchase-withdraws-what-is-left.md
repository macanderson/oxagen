# ADR-085: A refunded or disputed GAU purchase withdraws what is left, and records what it could not recover

- **Status:** Accepted
- **Date:** 2026-09-17
- **Owners:** billing
- **Related:** ADR-055 §6 (the GAU model and the settlement ledger),
  `packages/billing/src/gau-reversals.ts`, `packages/billing/src/disputes.ts`,
  `packages/billing/src/stripe-provider.ts`,
  `packages/database/src/schema/billing.ts`

## Context

A governed-action block purchase runs through Stripe Checkout. The paid session
fires `checkout.session.completed`, `grantGauPurchaseForCheckout` inserts a
`checkout` settlement keyed on the session id and adds the quantity to the
organisation's `gau_buckets.purchased_gau`. That is the whole sale.

Nothing unwound it.

Two things were missing, and each hid the other.

**The charge could not name the organisation.** `createGauCheckout` put the
purchase metadata on the Checkout Session and on the invoice it issues, but its
`payment_intent_data` carried only `setup_future_usage`. Stripe copies a
PaymentIntent's metadata onto the Charge it creates; a Session's own metadata
never reaches the Charge. So the charge a refund reads carried no `org_id`, and
`onChargeRefunded` fell through every fallback in `resolveOrgFromCharge` to
`logger.fatal(… "cannot resolve orgId; clawback NOT applied")`. The credit-pack
checkout (`createDynamicCreditCheckout`) has carried the same metadata on
`payment_intent_data` since it was written, which is why that path works and
this one did not.

**Even resolved, the clawback debits the wrong ledger.** `onChargeRefunded` and
`onDisputeCreated` call `consumeCredits`, which debits the usage-credit
ledger. A block purchase credits no usage credits. Clawing them back would take
money from an unrelated balance while the units it actually bought stayed in
`purchased_gau`, spendable.

A customer could therefore buy units, spend them, charge back, and keep
spending.

A dispute is a third problem on top. `stripeDisputeToNeutral` reads
`Stripe.Dispute.metadata`, which Stripe does not copy from the charge and which
nothing in this codebase sets — so `dispute.orgId` is always null and
`resolveOrgFromDispute`'s first path has never resolved anything. Propagating
metadata onto the PaymentIntent fixes the refund; it cannot fix the dispute.

## Decision

### 1. The purchase identity reaches the payment event twice

`createGauCheckout` puts the session metadata on `payment_intent_data.metadata`,
as the credit-pack checkout does. A refunded charge then carries `org_id` and
`oxagen_kind`.

`grantGauPurchaseForCheckout` also records the session's PaymentIntent on the
settlement, in `gau_settlements.stripe_payment_intent_id` (unique, partial).
That is the durable link, and the one a dispute needs: a refund and a dispute
both name the PaymentIntent, and the settlement is a local row, so neither
resolution depends on Stripe having copied metadata anywhere.

The settlement is also what says *how many units* the money bought, which
metadata on the charge never could.

### 2. The reversal debits the organisation's current bucket

Not the bucket the grant landed on.

A `gau_buckets` row is a month. The rollover copies rather than moves: last
month's row keeps its `purchased_gau` forever, and this month's row is created
with `carried_gau = min(prev.purchased + prev.carried, max(0, prev.remaining))`.
Only the current row is read by `assertGauAvailable` and by the page. Debiting
the grant's own bucket after a month boundary would be historically tidy and
would leave every refunded unit spendable — which is the defect, displaced by a
few days. Stripe accepts a dispute up to 120 days after the charge, so that is
not an edge case.

Units come off `purchased_gau` first, then `carried_gau`. That is the order
bought units are held in across a rollover.

### 3. Already-spent units are recorded, not pursued

`gau_buckets_counts_non_negative` refuses a negative `purchased_gau`. A reversal
that subtracted a full quantity from a bucket that no longer holds it would not
degrade — it would raise, and keep raising on every Stripe redelivery. So both
subtractions clamp at zero.

The shortfall is the decision this ADR exists for. Three options were open:
carry it as a negative balance, record it as a receivable, or record it and stop.

**We record it and stop.** `gau_reversals` carries `requested_gau`,
`reversed_gau` and `unrecovered_gau`, with a CHECK that the last two add to the
first.

A negative balance is not available: the column forbids it, and the constraint
is right — a count of units bought is not a place to store a debt.

A receivable is not built, and inventing one here would put a second money
mechanism into a webhook branch. It is also mostly unnecessary, because the
arithmetic already settles the common case honestly. Removing purchased units
lowers `remaining = included + purchased + carried − used`, which is allowed to
go negative, and raises uninvoiced overage
(`used − included − purchased − carried − overage_invoiced`) by the same amount.
An invoice-billed organisation is therefore billed for what it consumed on a
purchase it took the money back for. A prepaid organisation is blocked at
`remaining <= 0` until it buys again. Neither needed a new concept.

What the recorded figure buys is the case the arithmetic cannot reach: units
that rolled out of the live balance before the refund arrived. Those are not
recovered and not billed, and `unrecovered_gau` is where an operator reads that,
rather than inferring it from a bucket that looks tidy.

### 4. Idempotency matches the credit clawback

Stripe redelivers. The key is `(settlement_id, provider_event_id)` — the charge
id for a refund, the dispute id for a dispute — enforced by
`gau_reversals_settlement_event_idx` and pre-checked in the same transaction,
which is the shape `onChargeRefunded` already uses for the credit ledger
(`deterministicUuid(charge.id)` on `credit_ledger`).

Keying on the charge id has a consequence worth stating: Stripe's
`amount_refunded` is cumulative, so a *second* partial refund on one charge
redelivers the same charge id and is treated as a redelivery rather than as
further units to withdraw. The existing credit clawback behaves the same way. A
block purchase is sold in indivisible blocks and the product offers no partial
refund — the only partial refunds are operator goodwill from the Stripe
dashboard, and the first one is honoured pro-rata. Matching the existing key
beats inventing a second idempotency scheme for a case the product does not
create.

### 5. The dispatch is by what was sold, not by what resolves first

`onChargeRefunded` and `onDisputeCreated` attempt the GAU reversal before the
credit clawback. A match means the event was against a block purchase; the units
are withdrawn and the credit ledger is untouched, and for a dispute the
`billing_disputes` row is still written with `clawed_back_cents = 0`, because no
credits were taken.

A charge whose metadata says `oxagen_kind: "gau_purchase"` but which matches no
settlement stops with a fatal log rather than falling through. Before this
change the metadata was absent and the fall-through was unreachable; making the
charge resolvable would otherwise have made a GAU refund start debiting usage
credits, which is a worse failure than the one being fixed.

### 5. A refund that arrives before its purchase is parked, not dropped

Stripe does not order webhook deliveries, and `processStripeEvent` re-dispatches
only an event whose handler **threw** — a handler that returns marks the event
processed and it is never seen again. So a `charge.refunded` that finds no
settlement and returns is a refund that is gone, while the retried
`checkout.session.completed` goes on to grant the full purchase. That is the
same money-loss this record exists to prevent, reached by the opposite ordering,
and it does not need exotic delivery: a grant that failed once for any reason is
retried later, and the refund can land in between.

Two fixes were open.

**Throw, so Stripe retries.** Cheap, and it matches the webhook processor's own
documented contract. But it is a timing bet against Stripe's roughly three-day
retry budget: a grant delayed past it still loses the money, and a genuinely
unmatched charge retries for three days and is dropped anyway.

**Park the reversal and let the grant reconcile it.** Chosen. A timing bet
cannot be the durable answer to a money-loss path (SCR-002); the invariant is
that *the grant checks whether the money came back before it hands out units*.

An unmatched refund writes a `gau_reversals` row with `settlement_id` and
`bucket_id` NULL, keyed on the PaymentIntent — the one identifier a refund, a
dispute and a Checkout Session all carry. `grantGauPurchaseForCheckout` settles
any such row in the **same transaction** that grants, so the units are never
spendable in between. The two nullable links carry a CHECK that they are null
together: a row is pending or settled, never half of each.

The idempotency key moves from `(settlement_id, provider_event_id)` to
`(stripe_payment_intent_id, provider_event_id)`. One PaymentIntent charges one
Checkout Session, so for a row that has found its settlement this is the same
key by another name; it simply also holds before the settlement exists.

Reconciliation is idempotent twice over: the grant reaches it only on the
delivery that actually inserted the settlement (a redelivery hits
`ON CONFLICT DO NOTHING` and returns early), and the lookup matches only rows
still carrying `settlement_id IS NULL`.

**Parking without reconciling would be the same defect wearing a different
shape**, so the two halves are one decision and are tested as one. The grant
adds the purchase to the bucket and then settles any parked reversal against
it, both inside the transaction that inserted the settlement. Ordering within
that transaction is not observable — the upsert holds the bucket's row lock to
commit — so "add then withdraw" and "withdraw from the delta" are the same
thing to every reader; what matters is that no transaction can commit having
added spendable units without having consulted the parked rows.

The test for this has to go through `grantGauPurchaseForCheckout`, not through
the reconciliation helper. That is not pedantry: the helper was fully covered
in isolation while the grant's call to it was not, and deleting that call left
every one of those tests green. A test that exercises the helper proves the
helper. Only a test that runs the refund event first, the checkout event
second, and asserts the account's spendable balance proves the wiring.

One case stays manual: a charge whose metadata says `gau_purchase` but carries
no `org_id`. There is nothing to attribute a pending row to, and retrying cannot
conjure metadata that is not on the charge, so it logs a fatal.

### 6. A partial reversal prorates against what was paid, tax included

`quantity_gau * rate_per_gau_micros` reconstructs the **subtotal**. Stripe's
`amount_refunded` includes refunded tax. Prorating one against the other
over-withdraws by exactly the tax rate — half of a 5,500-cent tax-inclusive
charge is 2,750 cents, which against a 5,000-cent subtotal reads as 55% of the
units instead of 50%.

The error is invisible on a full refund, because the amount then exceeds the
subtotal and saturates at the whole quantity. Only a partial refund shows it,
and it compounds with the clamp in §3: the surplus units are not there to take,
so the shortfall is recorded as `unrecovered_gau` — a figure that looks like
spend but is arithmetic.

The settlement therefore records `charged_cents` from the Checkout Session's
`amount_total`, and that is the denominator. A settlement written before the
column existed falls back to the subtotal, which is exact for an untaxed
purchase and is the best figure available for a taxed one.

## Consequences

- A purchase made before this change has no `stripe_payment_intent_id` and no
  charge metadata. Its refund still logs the unresolved-org fatal and still
  needs manual intervention. There is no backfill without Stripe API calls
  against real objects; on a pre-launch branch the set is empty.
- A usage-credit **dispute** still cannot resolve an organisation, for the
  reason in Context: the dispute object carries its own metadata. That is a
  pre-existing defect with a different fix (a provider lookup of the charge,
  which means provider I/O in the dispute path) and is not fixed here. The
  misleading comment in `resolveOrgFromDispute` that claimed the path worked has
  been corrected.
- A dispute the organisation later wins is a manual re-grant. `dispute.closed`
  records the outcome and reverses nothing, which is what it already did for
  credits.
