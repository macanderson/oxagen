# ADR-055: Subscriptions carry monthly buckets of governed action units, bought in unit quantities at a per-customer contracted rate

- **Status:** Accepted
- **Date:** 2026-09-13
- **Owners:** platform
- **Refines:** ADR-052 (the governed action is the billable unit). The unit
  and its four exclusions stand. The pricing clause "tier allowance plus
  per-action overage" is replaced by the model below. Retention beyond the
  included window remains the second meter and is not on the rev1 page.
- **Related:** ADR-053 (funding sources; the assistant balance of a new
  organisation), ADR-042 (organisation data planes),
  [docs/specs/governed-action-metering.md](../specs/governed-action-metering.md)
  (the published figures, amended for this ADR),
  `apps/app/ARCHITECTURE.md` §1.4, §1.5, §3.9 and INV-27…INV-31 (the seams,
  the recorder and the contracts that implement this decision),
  the Mission Control spec `2026-09-11-oxagen-mission-control-spec.md`
  (§12.1, A.8, A.10 and Appendix E carry a dated amendment pointing here),
  `packages/billing/src/action-metering.ts` (the credit debit this retires),
  `packages/database/src/schema/billing.ts` (`plans`, `subscriptions`,
  `org_billing_settings`, `invoices`, `payment_methods`)

## Context

ADR-052 made the governed action the unit and left the price to the spec:
"tier allowance plus per-action overage", with the allowance on the plan
row per year and the overage priced at a global USD band. The code that
implements it counts actions per calendar year in
`billing.governed_action_counters`, ignores the subscription's own period,
prices the overage from `ACTION_RATE_BANDS` and debits a cents-denominated
credit balance. Exhaustion is a zero credit balance. The only self-serve
purchase sells dollars of credit. `create_org` grants five dollars of credit
to every new organisation.

The maintainer's direction for the Mission Control rebuild is that
subscriptions carry buckets of usage for governed actions; that governed
actions are purchased in quantities of governed action units, never in
dollars of usage; that the contracted rate for that customer is printed on
the billing page; that auto top-up exists from the first day; that a
platform operator can decide whether an organisation is invoiced for
governed action units or bills in advance; and that an organisation on
invoice billing has a maximum GAU spend before an invoice is cut, with
`approved_for_invoice_billing` defaulting to false and `invoice_gau_max`
defaulting to 100,000.

Three defects in the credit model drove the shape below. A dollar balance
has no unit the customer can reason about before purchase. An annual
allowance copied onto the organisation at creation drifts from the plan the
customer later moves to. A gate that also charges fails open when Stripe is
down.

## Decision

### 1. The unit and the exclusions stand

The governed action unit (GAU) is the billable unit. ADR-052's four
exclusions stand: only the outermost invoke bills; `noBillingGate: true`
capabilities are free; denials are free; a retry within one attempt bills
once. This ADR changes how GAUs are allowed, bought and settled, and
nothing about what one is.

### 2. Published terms live on the plan; negotiated terms live in one row per organisation

`billing.plans` carries the published terms of a tier: `currency`,
`rate_per_gau_micros`, `block_size_gau` and `included_gau_per_month`.
`billing.contract_terms` carries a negotiated agreement as one row per
organisation with the same four figures, an `agreement_ref`, and
`effective_from` / `effective_to`, with at most one row per organisation
whose `effective_to` is null. Both tables carry the check
`(rate_per_gau_micros * block_size_gau) % 10000 = 0`, so a block prices to
whole cents and no line needs rounding.

There is no `source`, `tier`, `stripe_price_id` or `exhaustion_policy`
column on the negotiated row: the source is implied by the table, the tier
is the entitlement's, the checkout uses `price_data`, and what happens past
the allowance is the organisation's billing mode (§5).

### 3. Effective terms are resolved at read time and never copied into the organisation

`resolveContractTerms(orgId)` returns the effective negotiated row when
one exists and otherwise the published figures of the plan the
organisation's entitled subscription names, or the Free plan for an
organisation with no entitled subscription. Nothing copies terms into the
organisation at creation or at a plan change, so a change on either table
is reflected on the next read and the next bucket.

The GAU model does not read `organizations.plan_type`. `create_org` only
ever writes `free` there, so a resolver that consulted it would have one
answer for one class of row. The GAU model has one resolver with one
fallback. `resolveOrgTier` keeps its own leg through that column because
it answers a different question, the IAM tier gate.

### 4. Every bucket is one month, and the allowance is per month

A `billing.gau_buckets` row covers one month per organisation.
`periodFor(subscription | null, now)` decides which:

- For an organisation with an entitled subscription, the month-long slice
  of the current cycle that contains `now`, starting on the cycle's
  anniversary day. A `month` subscription's slice is the subscription's
  own `current_period_start` / `current_period_end`. A `year`
  subscription is sliced by anniversary day, with the day clamped to the
  last day of a shorter month the way Stripe's billing-cycle anchor
  behaves (a cycle anchored on the 31st runs Jan 31 – Feb 28, Feb 28 –
  Mar 31, Mar 31 – Apr 30).
- For an organisation with no subscription, the UTC calendar month.

`included_gau = included_gau_per_month`, with no multiplier. An annual
subscriber is billed in advance by Stripe on its own cycle; the allowance is
what each month of that advance payment includes. An annual subscriber
therefore gets a monthly allowance and, in invoice billing, a monthly
overage invoice like everyone else. There is no twelve-month pool.

`remaining = included + purchased + carried − used` and may be negative.
The gate checks `remaining > 0` before the handler and the recorder debits
after it, so concurrent governed actions can drive `used` past the total.
The stored figure is not clamped; the page prints "overdrawn by N". On
rollover, purchased units that were not used carry forward; included ones
do not.

### 5. Two billing modes, decided by the organisation's billing row

`org_billing_settings` carries the mode, and it is one row per
organisation:

| Column | Default | Set by |
|---|---|---|
| `approved_for_invoice_billing` | `false` | platform operator only |
| `invoice_gau_max` | `100000` | platform operator only; read only when `approved_for_invoice_billing` is true, stored and inert otherwise |
| `auto_topup_enabled` | `true` | the customer (Owner or Admin), through `set_auto_topup` |
| `auto_topup_blocks` | `1` | the customer (Owner or Admin), through `set_auto_topup` |

The mode is set only by a platform operator through `set_org_billing_terms`,
a `platformOnly` capability the kernel refuses unless the context carries a
kernel-minted platform-operator binding that no surface builder mints. Its
only caller is the operator script `pnpm billing:terms`. The customer sees
the mode and the cap read-only.

The settings read on the GAU path (`readOrgBillingSettings`) returns the
column defaults for an organisation with no row and never inserts. A read
never writes.

### 6. Prepaid: blocks are bought in unit quantities; auto top-up runs once per exhaustion episode

Under the default mode an organisation gets GAUs beyond the allowance only
by buying blocks, in unit quantities of `block_size_gau`, at the contracted
rate:

- **Through Checkout.** `purchase_gau_bucket` opens a Stripe Checkout
  Session in payment mode with one `price_data` line at the block price and
  `quantity = blocks`, with invoice creation enabled and the card saved for
  off-session use. The handler recomputes the amount from
  `resolveContractTerms` at submit time. The webhook grant is an upsert
  keyed on the session id, so a second delivery grants nothing.
- **By auto top-up, from the recorder.** When a debit leaves the bucket at
  `remaining ≤ 0`, `auto_topup_enabled` is true and the organisation has a
  saved default payment method, the recorder claims one auto top-up
  episode for `auto_topup_blocks` blocks and charges the saved card through
  a Stripe Invoice. At most one automatic attempt runs per exhaustion
  episode. The episode ends when that settlement is paid (synchronously, by
  Stripe's retry schedule, or through the hosted invoice page), when a paid
  Checkout clears it, or when the next month opens a new bucket.

Only when auto top-up cannot run, because it is disabled, no payment method
is saved, or the one attempt of the episode did not pay, is the next
governed action refused by the gate with `gau_exhausted` (HTTP 402). The
gate never charges. Every tier, including Free, may buy a block: a block
is a unit purchase at the organisation's contracted rate.

### 7. Invoice billing: consumption is never capped; overage is invoiced at period end or at `invoice_gau_max`

An organisation with `approved_for_invoice_billing = true` is never
refused for lack of GAUs. Its overage beyond the allowance accrues and is
invoiced at the contracted rate:

- **At period end**, by the close job (§9), for the uninvoiced overage of
  the month.
- **As an interim invoice** for exactly `invoice_gau_max` GAUs, on the day
  accrued uninvoiced overage reaches `invoice_gau_max`. The claim subtracts
  exactly the cap, so accrual restarts at GAU #`invoice_gau_max`+1. A second
  crossing in the same month gets the next sequence number.

Either invoice is charged on the saved payment method that day when one
exists; when none does it is a `send_invoice` invoice due in 30 days, which
Stripe emails and the hosted invoice page collects.

An interim invoice does not move the monthly clock: the period-end invoice
covers the remainder of the month and the subscription's own advance bill
is untouched. An interim or period-close invoice unpaid on the day leaves
the organisation running, flags it past due on the billing page, and stays
collectable by Stripe: its retry schedule on a card, the hosted invoice
page in either case. There is no automatic suspension for GAU invoices in
rev1. Subscription dunning is unchanged and still suspends.

Switching an organisation from invoice billing to prepaid closes the
accrual: `set_org_billing_terms` cuts an interim invoice for the uninvoiced
amount in the same call, so no overage is stranded between the modes.
Switching to invoice billing needs no settlement; purchased units stay
usable as carry.

### 8. One settlement ledger; `paid` is its only terminal state

Every block purchase, auto top-up, interim invoice and period-close charge
is a Stripe Invoice, recorded in `billing.gau_settlements` with a `kind`
(`checkout` | `auto_topup` | `interim_invoice` | `period_close`), the
quantity, the rate and currency it charged, and a `status` of `pending` |
`open` | `paid` | `failed`.

- **`paid` is the only terminal state.** A row that is `open` or `failed`
  still grants when its invoice is eventually paid.
- **The grant is conditional on `status <> 'paid'`.** `settleGauPaid`
  updates the row only when it is not already paid and grants only when
  that update returned a row, so the synchronous result, the first
  `invoice.paid` and the `invoice.paid` of Stripe's later retry converge on
  one grant whichever arrives first. The grant lands in the organisation's
  current bucket, never in a closed one.
- **Idempotency is the settlement id and the session id.** The settlement
  id is the Stripe idempotency key for every request the settlement makes;
  the Checkout session id is the key of the webhook grant. A unique index
  on `(bucket_id, kind, seq)` is the database backstop for one interim
  settlement per threshold crossing and one auto top-up per episode.
- **The claim commits before the first Stripe call.** A crash after the
  claim leaves a `pending` row the close job resumes from Stripe's own
  state; a claim rolled back after a successful charge would leave a paid
  invoice under keys nothing remembers.
- Drafts are created with `auto_advance: false` and finalized with
  `auto_advance: true`, so Stripe collects only an invoice Oxagen finalized
  and never a draft Oxagen abandoned.

The amount, the hosted URL and Stripe's own status of a settlement's
invoice are read from the webhook mirror `billing.invoices`, which
`list_invoices` joins to the ledger to label each invoice's kind.
`billing.invoices` and `billing.payment_methods` are retained as the
webhook mirrors of Stripe's invoices and of the saved default card.

### 9. One hourly close job, per organisation

`billing.gau-close` runs hourly. It closes every bucket whose month has
ended, cutting the period-close invoice for an invoice-billed
organisation with uninvoiced overage, and resumes every settlement that has
been `pending` for more than an hour from Stripe's own state. Months end on
each organisation's own anniversary day (or the calendar month end for the
fallback), so each organisation closes on its own day. A row Stripe never
answered within the idempotency window, or a pending auto top-up that a
paid Checkout superseded, is marked `failed` with its draft deleted or
voided; a `failed` row never has a collectable invoice behind it.

### 10. Dunning applies to subscription invoices only

`onInvoiceRecovered` and `onInvoicePaymentFailed` run only for an invoice
that carries a subscription id. A paid GAU invoice never resets a
suspended organisation to active, and a declined GAU top-up never starts
dunning. GAU invoices settle through the ledger (§8) and nothing else.

### 11. The rate printed to the customer is the plan's or the negotiated row's, never a global band

The billing page prints the customer's contracted rate, its source
("Published <Tier> rate" or "Negotiated agreement <ref>"), the block size,
the block price, the currency, the included GAUs per month and the
effective dates, all from `resolveContractTerms`. `ACTION_RATE_BANDS` is
never the source of a figure shown to a customer or charged to one. The
bands survive only as the published volume rate card that `get_rate_card`
and `preview_action_cost` report for quoting.

### 12. Tokens and retention are not on the page

`get_subscription.periodUsage` stays a report the app does not render. No
table carries a retention rate and no app component prints one.
`get_rate_card` and `get_evidence_retention` keep reporting the published
`RETENTION_USD_PER_GB_MONTH` constant for their API and MCP callers
(`billing.action_rate_card.ts:90`, `billing.evidence_retention.ts:119`;
the latter with `storedGbMeasured: false`, since no job measures
per-organisation evidence volume), and both stay unbound in the app.
Retention settles later as an invoice line at a contracted per-GB-month
rate that the lane which meters per-organisation evidence volume adds to
`plans` and `contract_terms`. `chargeEvidenceRetention`, which had no
production caller, is deleted.

### 13. `create_org` grants no credits

`create_org` writes nothing billing-shaped: no credit grant, no
`contract_terms`, `gau_buckets`, `gau_settlements` or `org_billing_settings`
row. The ADR-053 platform-funded assistant balance of a new organisation
starts at zero. Whether a signup grant returns with the assistant is an open
question for the maintainer, not a default.

### 14. The rev1 metering surface

`apps/app/ARCHITECTURE.md` §1.5 is the whole rev1 metering surface, and
this ADR records it:

- **`resolve_approval` is the only governed action** the rev1 app can
  trigger, and only a decision that matched a row. When its update matches
  no row (unknown, expired, already resolved, wrong workspace) the handler
  throws a `conflict`, the invocation leaves through the kernel's catch, and
  the recorder never runs. An unmatched id is never billed.
- **Every console read is `noBillingGate: true`** (`list_runs`, `get_run`,
  `list_approvals`, `list_members`, `list_api_keys`, `list_orgs`,
  `list_workspaces`, the four billing reads), so a page load or a stream
  poll never meters and never locks a customer out.
- **Every membership write is `noBillingGate: true`** (`change_member_role`,
  `remove_org_member`, `accept_member_invite`, `decline_member_invite`),
  per ADR-052 exclusion 2, as are the settings and credential writes
  (`create_api_key`, `revoke_api_key`, `dispatch_tacho_command`,
  `authorize_cli`, `set_auto_topup`, `set_org_billing_terms`) and the
  purchase (`purchase_gau_bucket`). Buying more is never refused for lack
  of GAUs.

### 15. What is retired

`billing.governed_action_counters`, `plans.included_actions_annual`, the
credit debit on the governed-action path (`creditsForActions` and the
`consumeCredits` call the recorder made), `OXAGEN_ACTION_METER_MODE` with
`resolveActionMeterMode`, `chargeEvidenceRetention` with
`retentionCreditsForGbMonths`, `get_action_usage` with its panel, and the
`grantFreeCredits` call in `create_org`. A shadow mode that charged a card
or cut an invoice would not be a shadow, and one that did neither would
leave a prepaid organisation running past exhaustion with no record. This
is the zero-customer window; there is no migration of billed history.

## Alternatives

**A twelve-month bucket for an annual subscriber.** Rejected. It gave an
annual subscriber a year's allowance to spend in month one and, in invoice
billing, one overage invoice a year, against the direction's monthly
allowance billed in advance each month and a monthly invoice at period end.
Every bucket is one month for every organisation.

**Copy the tier's terms onto the organisation at creation.** Rejected. A
frozen copy drifts from the plan the customer later moves to and needs a
second writer to keep current. Terms are resolved live from two tables with
one fallback.

**A gate that charges at exhaustion.** Rejected. A gate that also bills
fails open when Stripe is down. The gate reads and refuses; the recorder,
which runs after the handler and is never retried, is where money moves.

**A bare PaymentIntent for the auto top-up.** Rejected. It leaves no
invoice, and the direction wants one record per top-up. Every charge is a
Stripe Invoice, and the ledger keys every request on the settlement id.

**`expired` and `superseded` as ledger states.** Rejected. A row that is
`open` or `failed` still grants when its invoice is paid, so no state other
than `paid` may be terminal; the reason a row is `failed` is in the job's
log, not a column.

**A hard stop with no auto top-up.** Rejected by the direction: auto
top-up is a first-day requirement, and refusal is what happens only when
it cannot run.

**Capping an invoice-billed organisation.** Rejected. The cap on invoice
billing bounds the uninvoiced exposure, not consumption: reaching it cuts
an invoice and accrual restarts.

## Consequences

- The metering spec's allowance table is restated per month with a per-GAU
  rate, a block size and a currency per tier; the figures move with the
  spec, and the plan rows they seed are the published terms.
- `apps/app` prints money in exactly two places, the contracted rate block
  and the invoices list, plus the total on the purchase form; every other
  billing figure is a GAU count.
- Concurrent governed actions serialise on the bucket row; the boundary is
  exact under concurrency and the stored `remaining` may be negative.
- A prepaid organisation cannot auto top-up until it has bought a block once,
  because the Checkout is the only card capture in rev1; an invoice-billed
  organisation has no way to save a card in rev1, so its invoices are
  `send_invoice` with 30-day terms. Both are open questions for the
  maintainer.
- The Mission Control spec's per-run model (§12.1), `included_runs` (A.8),
  the Appendix E billing rows and the "billing.invoices is gone" row of
  A.10 are superseded by this ADR; the spec carries a dated amendment at
  each place.
