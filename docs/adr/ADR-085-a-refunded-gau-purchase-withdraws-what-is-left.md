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

### 7. The grant and the reversal serialise on the PaymentIntent

Parking and reconciling is not enough on its own, because the two halves race.

`processStripeEvent` dispatches deliveries concurrently by design. Under READ
COMMITTED, with no shared lock, a grant and a refund for one PaymentIntent
interleave like this:

```
refund tx                          grant tx
─────────                          ────────
                                   INSERT settlement      (uncommitted)
SELECT settlement  → none          │
INSERT pending reversal            │
│                                  SELECT pending → none  (uncommitted)
COMMIT                             COMMIT
```

Both commit. The purchase stays spendable and the reversal stays pending for
ever, because a checkout redelivery stops at the settlement that now exists and
never reaches reconciliation again. Neither transaction did anything wrong in
isolation — this is a write skew, and the bucket's row lock does not prevent it
because the two transactions write different tables.

The invariant in §5 — *no transaction can commit having added spendable units
without having consulted the parked rows* — holds only under serialisation.
Two concurrent transactions each consult the parked rows, each see nothing, and
each commit. An invariant has to be one that two concurrent transactions cannot
**both** satisfy, which means a lock they both take before deciding.

Both paths take `pg_advisory_xact_lock` over `gau_purchase:<payment_intent_id>`
before reading anything: the same idiom as `bind_main_repository`
(`repository.main.bind.ts`), xact-scoped so it is released on commit or
rollback with no unlock path to forget. Whichever transaction goes second sees
the first's committed work and takes the correct branch — the refund finds the
settlement and withdraws directly, or the grant finds the parked row and settles
it.

This cannot be proved against the in-memory executor, which is single-threaded:
a fake that cannot model two connections cannot exhibit a skew between two
transactions, and a sequential test passes against the unlocked code because
sequential is the ordering that already worked.
`packages/database/integration/gau-reversal-concurrency.test.ts` drives one
forced interleaving on two real connections with the lock as the only variable,
and asserts the unlocked case still reproduces the hazard so the locked case
cannot quietly stop testing anything.

### 8. A dispute resolves its organisation from the charge

The parking in §5 keyed on the PaymentIntent because it is the one identifier a
refund, a dispute and a Checkout Session all carry — and then the dispute path
did not use it, so a dispute arriving before its grant was still dropped: it
supplied no organisation, `applyGauReversal` returned null, and
`onDisputeCreated` logged the unresolved fatal and returned, marking the webhook
processed for ever.

It could not supply one. A Stripe Dispute carries its own metadata, which Stripe
never populates from the charge and nothing here sets, so a dispute arrives with
neither the organisation nor any indication of what was bought. That is also why
`resolveOrgFromDispute` has never resolved anything (#3189): its first path
reads that empty metadata, and its second looks the dispute up in
`billing_disputes` by the dispute's own id, so it can only return what the first
path already stored.

The charge has both. `getChargeMetadata` reads it once per dispute, outside any
transaction, and the result serves both purposes: `oxagen_kind` says whether to
park, and `org_id` is the organisation — for a usage-credit dispute as much as a
GAU one, which is what closes #3189's root cause. A charge that cannot be read
degrades to `{}` rather than throwing, because a webhook retried for a fault
that retrying cannot fix is worse than a logged fatal.

### 9. A charge read that fails is not a charge read that answered

§8 resolves a dispute's organisation from the charge, and the first version of
that read swallowed every failure into `{}`. A 5xx, a timeout or a rate limit
therefore told the dispute handler the charge has no organisation and bought
nothing — so the dispute was dropped and the webhook marked processed for ever,
while a later checkout retry handed out every unit. That is §5's defect exactly,
reached through a failed read instead of a missing field.

The distinction is between Stripe *answering* and Stripe *failing to answer*.
`StripeInvalidRequestError` (the id is wrong or the resource is gone) and
`StripePermissionError` are answers: retrying returns the same thing, and `{}`
is correct. Everything else — including an error carrying no Stripe type at all,
such as a transport timeout — is the absence of an answer and propagates.

Throwing *is* the retry. `processStripeEvent` re-dispatches only an event whose
handler threw, and Stripe's own backoff is a better retry loop than one held
open inside a webhook handler. Unknown errors default to transient, because an
extra redelivery costs far less than a dropped dispute.

This also repairs §7's invariant. The charge read happens **outside** the
advisory lock, and its result decides whether to park — so the guarantee that
"nothing read outside the lock decides anything" depends on that read being
both immutable and reliable. Stripe charge metadata is immutable: it is set when
the PaymentIntent is created and nothing mutates it. It was not reliable, and a
wrong value reaching the park decision is a violation whether it arrives by
concurrency or by an outage. The mutable input — *does a settlement exist?* — is
and always was read inside the lock, which the statement-order tests assert
directly.

### 10. A partial refund is cumulative, so the key is the amount, not the id

Stripe's `charge.amount_refunded` is the total refunded over the charge's life,
and a second partial refund redelivers the **same charge id** with a larger
figure. Keyed on the id alone — as §4 originally settled it, matching the credit
clawback — that reads as a redelivery and withdraws nothing: the customer gets
more money back and keeps the units.

§4's reasoning was that the product sells indivisible blocks and offers no
partial refund, so the only partial refunds are operator goodwill from the
dashboard. That is true and still not a reason to lose the second one.

The comparison is now on the amount:

- **equal** — a genuine redelivery. No-op.
- **greater** — new money. Withdraw the difference.
- **smaller** — a stale delivery arriving out of order. Ignored; units are never
  given back by a webhook arriving late.

The units for an increase are recomputed for the new **cumulative** total and
the already-recorded figure subtracted, rather than prorating each delta on its
own. Proration floors, so summing per-delta figures drifts below what the
customer was actually refunded; recomputing the whole floors once, and the row
ends equal to one proration of the cumulative amount however many deliveries
built it.

A row still pending has no settlement to price against, so an increase only
records the larger amount and reconciliation prorates the final total once.

### 11. One debit path, because the rule did not survive being written twice

§7 established the PaymentIntent advisory lock, and §3 established that the
absolute-valued bucket write is only correct because `ensureCurrentBucket`'s
upsert holds the row lock. Both were true of the first reversal path. The
cumulative-refund path in §10 was written beside it with a plain `SELECT` and an
absolute write, and inherited neither — a correct fix that was a property of the
branch it was applied to rather than of the module.

Two defects came out of that one omission.

**The advisory lock never protected the bucket.**
`gau_purchase:<payment_intent_id>` serialises reversals of *one purchase*
against each other. A concurrent checkout grant or auto top-up is a **different**
PaymentIntent, takes a **different** lock, and proceeds freely — it was never
held back at all. So a plain read followed by
`purchased_gau = <snapshot> − delta` is a read-modify-write over a row that
other, differently-keyed transactions increment, and the absolute write erases
whatever landed in the gap. The §7 invariant — "two concurrent transactions
cannot both satisfy it" — held for the pair it was written about and was silent
about this one.

**A stored `bucket_id` is not where the units live.** After a rollover, the
units a second refund must take are the *current* bucket's `carried_gau`;
`existing.bucket_id` records where the *first* refund took its units. Debiting
that historical row leaves the current balance spendable although more money
went back.

Both are fixed by the same thing, and deliberately by the same *code*:
`debitCurrentBucket` is now the one implementation every single-debit path
calls. It resolves the bucket at debit time (so the rollover case is right by
construction) and takes the row lock through `ensureCurrentBucket` (so the
absolute write is safe against any other writer, whatever lock it holds).

Choosing the row lock over an atomic SQL decrement was deliberate. An atomic
`SET purchased_gau = purchased_gau − LEAST(purchased_gau, $n)` removes the
window rather than guarding it, which is attractive — but it cannot report *how
much it removed* without reading the prior values, and `reversed_gau` /
`unrecovered_gau` are the record this whole design exists to keep. Recovering
the old values needs either `RETURNING` over the old row (Postgres 18) or a
`FOR UPDATE` CTE, which is the row lock again with more moving parts. The row
lock is also what the grant, the recorder and the first reversal path already
take, and one concurrency strategy in a module beats two correct ones.

The lesson the sequence records: a fix applied to a branch is not a fix to the
module. The way to make it one is to leave a single implementation behind, not a
comment asking the next writer to remember — there *was* such a comment, ten
lines of it, on the path that had it right, and the second path was written
anyway.

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
