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

### 4. Idempotency is keyed on the PaymentIntent, and compares the amount

Stripe redelivers. The key is `(stripe_payment_intent_id, provider_event_id)` —
the charge id for a refund, the dispute id for a dispute — enforced by
`gau_reversals_payment_intent_event_idx` and pre-checked in the same
transaction, which is the shape `onChargeRefunded` already uses for the credit
ledger (`deterministicUuid(charge.id)` on `credit_ledger`). It is keyed on the
PaymentIntent rather than the settlement so that it also holds for a row parked
before its purchase was known (§5); for a row that has found its settlement the
two are the same key by another name, since one PaymentIntent charges one
Checkout Session.

**The key alone is not the whole rule, and the decision changed during this
change.** What was first accepted here was that a *second* partial refund on one
charge redelivers the same charge id and is therefore treated as a redelivery,
withdrawing nothing further — on the reasoning that a block purchase is sold in
indivisible blocks, that the product offers no partial refund, and that matching
the existing credit-clawback key beat inventing a second idempotency scheme for
a case the product does not create.

That was wrong, and measuring it is what changed it. Stripe's `amount_refunded`
is **cumulative over the charge**, not per-refund: a second partial refund
redelivers the same charge id carrying a *larger* figure. An id-only key reads
that as a redelivery and withdraws nothing, so the customer receives more money
back and keeps the units — the money-loss this ADR exists to close, reached
through the idempotency check instead of through the handler. The reasoning
above does not save it either: operator goodwill from the Stripe dashboard is
precisely how these refunds arise, and nothing stops an operator issuing two.

So the check compares the **amount**, not just the id. An equal amount is a
redelivery and withdraws nothing; a larger one is new money and withdraws the
difference, recomputed against the new cumulative total rather than prorated
per delta, because proration floors and summing per-delta figures drifts below
the total actually refunded; a smaller one is a stale delivery arriving out of
order and is ignored. §10 carries the mechanism.

Independently of the sequence, no set of events against one purchase may
withdraw more than the units that purchase granted — see §14, which is a
different rule with a different cause, and is enforced across every reversal row
for the settlement rather than within one charge's history.

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

The interleaving is constructed with an in-process barrier, not with timers. A
timer-ordered version works on an idle box and is load-dependent everywhere
else: on a busy runner the window can elapse before the first transaction
reaches the point the race needs, the interleaving never happens, and the
*unlocked* variant observes the correct state — passing for the wrong reason,
which is the failure these tests exist to rule out, occurring in the
discriminator itself. With a barrier the second transaction proceeds because the
first has demonstrably arrived.

The locked variants keep a capped wait, because there the peer is blocked on a
lock this transaction holds and cannot arrive; waiting for it would deadlock.
That is not a residual timing dependency but the lock doing its job, and those
assertions hold for either resulting order by design. That the *unlocked* paths
never reach the cap was verified rather than assumed: with the timer branch made
to throw, both unlocked tests still pass.

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
degrades to `{}` only when retrying genuinely cannot change the answer; §9
settles which failures those are.

### 9. A charge read that fails is not a charge read that answered

§8 resolves a dispute's organisation from the charge, and the first version of
that read swallowed every failure into `{}`. A 5xx, a timeout or a rate limit
therefore told the dispute handler the charge has no organisation and bought
nothing — so the dispute was dropped and the webhook marked processed for ever,
while a later checkout retry handed out every unit. That is §5's defect exactly,
reached through a failed read instead of a missing field.

The first attempt at that distinction asked whether Stripe had *answered*, and
put `StripePermissionError` on the answering side. That was wrong, and wrong in
the expensive direction. The test is not "did Stripe answer" but **"can this
answer change on its own?"** — because what the caller needs to know is whether
the redelivery will say anything different.

- A charge that does not exist will not exist on the redelivery. Nothing anyone
  does changes it. Definitive.
- A key that lacks `charges:read` can be granted it by an operator five minutes
  later, and the identical call then returns real metadata. That is a fact about
  our configuration, not about the charge. Transient.

Those are different facts, and the first classifier mapped them to one branch.
So the definitive branch is now exactly one condition:
`StripeInvalidRequestError` **with `code === "resource_missing"`** — Stripe
looked, and there is no such charge. Every other invalid request (a bad expand,
an API version we no longer send, a malformed id) is our own defect, correctable
by a deploy, and while it lasted it would finalise *every* dispute that reached
it. Losing every disputed unit systematically is far worse than a redelivery.
This also matches `deleteOrVoidDraftInvoice`, which has keyed on
`resource_missing` rather than on error type since it was written.

Everything else propagates: permission and authentication faults, rate limits,
connection errors, 5xx, and an error carrying no Stripe type at all, such as a
transport timeout.

The fork is written as a **total mapping** over `Stripe.errors.StripeError["type"]`
— the SDK's own union — closed with `satisfies`, so an SDK upgrade that adds an
error type is a compile error until someone classifies it. A list of two would
have been cheap to extend and silent when extended wrongly. A runtime fallback
survives alongside it, because the caught value arrives as `unknown` and a type
string this build has never heard of is precisely the case the compiler cannot
reach; that fallback is `retry`.

Throwing *is* the retry. `processStripeEvent` re-dispatches only an event whose
handler threw: it records the error without setting `processed_at`, rethrows,
the route answers non-2xx, and Stripe redelivers — at which point the event is
not a duplicate and the dispute parks. Stripe's own backoff is a better retry
loop than one held open inside a webhook handler.

The two costs are not symmetric, and that asymmetry decides every doubtful case.
Wrongly retrying costs a redelivery. Wrongly finalising costs the units: no
metadata means no organisation, so the reversal is not parked, the handler
returns, the event is marked processed for ever, and the retried checkout grants
every disputed unit. Unknown therefore resolves to retry, never to definitive.

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

`reconcilePendingGauReversals` was the last place the rule lived outside the
code that writes, and it goes the same way. It took the caller's bucket snapshot
and tracked running counts across the pending rows, deferring one write to the
end. That was *provably* safe — the grant holds the row lock for its whole
transaction — but it was safe by context, which is the shape that has now failed
twice here by being written beside. It now calls `debitCurrentBucket` per row,
and the running counts delete themselves: they only ever stood in for a re-read,
and standing in for a re-read with a held snapshot is precisely the defect. The
change removed 14 lines net and one parameter, which is the usual sign that the
safety argument was doing work the code should have been doing.

### 12. The writers of `gau_buckets`, named

§7 and §11 both rested on a claim about "every other writer", which is the
unnamed-set shape §11 itself warns about. So here is the set, at the time of
writing: eight writers, none in tests.

| site | columns |
|---|---|
| `gau-settlements:112` | `open_topup_settlement_id`, `topup_seq` (+1), `updated_at` |
| `gau-settlements:164` | `overage_invoiced_gau` (+q), `interim_seq` (+1), `updated_at` |
| `gau-settlements:264` | `open_topup_settlement_id = null`, `updated_at` |
| `gau-settlements:469` | `closed_at`, `updated_at` |
| `gau-settlements:478` | `closed_at`, `overage_invoiced_gau` (+q), `updated_at` |
| `gau-settlements:856` | `open_topup_settlement_id = null`, `updated_at` |
| `gau-bucket:268` | ON CONFLICT: `used_gau` (+), `purchased_gau` (+), `updated_at` |
| `gau-reversals:193` | `purchased_gau` (absolute), `carried_gau` (absolute), `updated_at` |

On the columns the reversal writes, the only other writer is the upsert's
relative increment — the one §7 and §11 enumerated. `carried_gau` is stronger
still: nothing else writes it at all after creation, because the upsert's
conflict branch does not name it.

The reversal never names `used_gau`, so it cannot participate in violating
`gau_buckets_overage_invoiced_within_used`, which couples that column to
`overage_invoiced_gau`.

**One correction to a plausible worry.** A read-modify-write that reverts a
column it did not mean to change is a real shape, and it is *not reachable*
here: the read feeding the write happens inside the row lock, so its values are
never stale, and a whole-object write would be correct too. That was checked
against real Postgres rather than reasoned — the mutation stays green across
four runs, and a test claiming to discriminate it would have been a test proving
nothing.

Naming only the owned columns is therefore defence in depth, not the guarantee.
It is asserted anyway, because the guarantee is a property of where the *read*
sits, and a future edit could move it outside the lock while leaving the write
looking identical. The column-ownership assertion is what survives that edit; it
fails when the `.set()` is widened.

### 13. The enumeration stays a dated snapshot, and is not made into a gate

§12 lists eight writers. The obvious next move is a check that greps for writers
outside an allowlist, turning the snapshot into something a ninth trips. That
was considered and rejected on evidence, and the reasoning is recorded because
the *absence* of a gate here should read as a decision rather than an oversight.

**It would be blind to this package's own write idiom.** `spend-counter.ts` and
`price-book.ts` write tables with ``tx.execute(sql`INSERT INTO ${schema.x} …`)``.
Raw-SQL writes are established practice here, not hypothetical, and a grep for
the Drizzle builder cannot see them. A gate that reports clean on a class of
thing it cannot see is worse than no gate, because its green is read as evidence.

**It could not fire on the likeliest ninth writer.** Six of the eight live in
`gau-settlements.ts`. A file-level allowlist — the only stable form — allowlists
that file, so a ninth added there does not trip it, and that is much the most
probable place for one.

**A line-level allowlist would churn into uselessness.** These line numbers moved
repeatedly while this record was being written. An allowlist needing an update on
nearly every edit becomes something regenerated without reading, which is how a
gate stops being one.

**What holds without maintenance is already in place.**
`gau_buckets_counts_non_negative` and `gau_buckets_overage_invoiced_within_used`
are CHECK constraints. Postgres enforces them against every writer — Drizzle
builder, raw SQL, a future trigger, a hand-run `psql` — with no allowlist and no
way to be out of date. They are the assertion form of the part that matters.

So the honest shape of this record's guarantees, which is worth keeping straight
because the two read alike:

| claim | kind | defended by |
|---|---|---|
| the reversal's write names three columns | property of code | a unit assertion that fails when widened |
| its read is inside the row lock | property of code | statement-order tests + the two-connection race |
| counts never go negative; overage ≤ used | property of the database | CHECK constraints, against every writer |
| **"nothing else writes these columns"** | **snapshot of the tree** | **nothing — true when written, dated** |

An enumeration is evidence about the tree at a moment; an assertion is a property
the tree cannot leave. Every "we checked, nothing else does X" is the first kind
while reading like the second.

### 14. One purchase's units are capped across every event against it

§10 keys a CUMULATIVE refund on the amount, so a charge redelivered with a
larger figure withdraws only the difference. That settles one charge growing.
It says nothing about two DIFFERENT events against the same purchase: a refund
carries `ch_…` and a dispute carries `dp_…`, so the idempotency key
`(payment_intent, provider_event)` does not match between them and each reaches
the settlement lookup on its own. Each then priced itself against
`quantity_gau` from scratch and debited the full prorated quantity a second
time.

Nothing downstream can catch it. A GAU bucket is ONE balance for the
organisation, not a balance per purchase, so `debitCurrentBucket` has no way to
tell a unit this purchase paid for from a unit another purchase paid for — and
the units still in the bucket after the first event are, by definition, the
other purchase's. The second event therefore consumed units the customer still
owned, and reported success.

So the reversal is capped before the debit, at what the purchase has left to
give: `quantity_gau` less the `requested_gau` already recorded by rows for that
settlement. Three sites compute it — the new matched reversal, the cumulative
increase (excluding the row it is replacing), and the reconciliation loop —
because all three price against a settlement.

Two choices inside the cap are load-bearing:

- **It sums `requested_gau`, not `reversed_gau`.** The question is what the
  money entitled the reversal to take, not what the bucket happened to hold. A
  first event that found the bucket empty still spent the purchase's
  entitlement; §3 records those units as `unrecovered_gau` and does not pursue
  them. Counting what was recovered would let the entitlement be claimed again
  the moment a later purchase refilled the bucket — the same double debit by a
  longer route.
- **It is scoped to the settlement, not to the bucket.** A cap counting every
  reversal in the bucket would refuse a legitimate refund of a purchase nothing
  has reversed yet, which is a second money bug pointing the other way.

The test that covered the refund-then-dispute sequence before this passed on
the unfixed code: its bucket was empty by the time the dispute arrived, so the
second full-quantity debit recovered nothing and looked correct. It asserted
`requested_gau: 10_000` for that dispute, which is the defect's own output
written down as the expectation. A bucket that still holds another purchase's
units is what distinguishes the two, and that is what the tests now seed.

### 15. The purchases that already exist get a payment identity too

Adding `stripe_payment_intent_id` fixes the purchases made after the column
exists. Every checkout settlement recorded before it carries NULL, and the
`createGauCheckout` that paid for those put no metadata on the PaymentIntent
either, so the Charge cannot name the purchase from the other side. A refund or
dispute against one of them matches no settlement, cannot be parked, and leaves
the units spendable — the money-loss this ADR exists to close, still open for
the whole population that existed on the day it shipped. A fix at the write
path does not reach state written before it.

**The identity is recoverable without calling Stripe, and the coverage is
structural rather than best-effort.** `billing.stripe_events` is an immutable
raw-event store: `processStripeEvent` inserts the full webhook payload *before*
dispatching it, never updates the row, and nothing in the tree deletes one. A
`kind='checkout'` settlement can only have been created by
`grantGauPurchaseForCheckout`, whose single caller is the
`checkout.session.completed` branch of that dispatch. So the event that created
each of these rows is still present, joinable on the session id the settlement
already records, and `payment_intent` and `amount_total` are read straight off
it. The migration backfills both.

`charged_cents` is backfilled for the same reason and it is not cosmetic:
without it `reversibleGau` falls back to the subtotal, and since a refund's
amount includes refunded tax, a *partial* refund of a legacy purchase
over-withdraws by exactly the tax rate — §6's defect, fixed for new rows and
left standing for old ones. This is the second instance of the same shape in
one change, which is the argument for looking for the shape rather than for the
instance.

**The alternative considered and rejected: a legacy provider lookup.** Asking
Stripe for the session at refund time does not depend on what was stored, but
it puts a network call and a new failure mode on the money path, needs
credentials wherever reversals run, and — given the event store makes coverage
a property of how rows are written — buys nothing the backfill does not already
reach.

**The residue fails loudly and safely, in that order.** Whatever the backfill
cannot reach is reported at deploy time by a `RAISE WARNING` naming the count,
not swallowed. It is a warning and not an exception on purpose: a row this
cannot reach is not fixable from inside the migration, and wedging every future
deploy behind it would trade a bounded, alerting blind spot for an unbounded
outage. At runtime, `onChargeRefunded` refuses the usage-credit clawback while
any such settlement remains for that organisation and a refund's charge does not
say what it bought — because a block purchase's clawback would debit a balance
it never credited, and "completes after a fatal log" is the behaviour being
fixed, not one to reproduce in the new path. The probe is scoped to the one
organisation and to settlements that actually lack the identity, so it clears
itself once the backfill has run and one customer's unresolved purchase never
refuses another customer's refund.

## Consequences

- A purchase made before this change has no `stripe_payment_intent_id` and no
  charge metadata **on the day the column lands**, and §15's migration gives
  almost all of them one from the retained `checkout.session.completed` payload
  without calling Stripe. What is left over is the narrow residue that join
  cannot reach: a `kind='checkout'` settlement whose creating event is missing
  from `billing.stripe_events`, or whose payload carries no `payment_intent`
  (a session Stripe settled without one). Only those still need resolving by
  hand from the Stripe dashboard. The migration `RAISE WARNING`s their count at
  deploy time, and until they are resolved `onChargeRefunded` refuses the
  usage-credit clawback for that one organisation when the charge does not say
  what it bought, rather than debiting a balance the purchase never credited.
- A usage-credit **dispute** still cannot resolve an organisation, for the
  reason in Context: the dispute object carries its own metadata. That is a
  pre-existing defect with a different fix (a provider lookup of the charge,
  which means provider I/O in the dispute path) and is not fixed here. The
  misleading comment in `resolveOrgFromDispute` that claimed the path worked has
  been corrected.
- A dispute the organisation later wins is a manual re-grant. `dispute.closed`
  records the outcome and reverses nothing, which is what it already did for
  credits.
