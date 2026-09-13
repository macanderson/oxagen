# Governed-action metering — the meter, the rate card, and the move off cost-derived credits

- **Status:** Accepted
- **Date:** 2026-09-08 (open questions answered 2026-09-10; amended
  2026-09-13 for ADR-055)
- **Author:** platform
- **Related:** [ADR-052](../adr/ADR-052-governed-action-as-the-billable-unit.md)
  (the decision), [ADR-055](../adr/ADR-055-gau-buckets-and-contracted-rates.md)
  (the bucket model this spec's figures serve),
  [ADR-042](../adr/ADR-042-tenant-data-planes.md)
  (organisation data planes), [ADR-043](../adr/ADR-043-runtime-excision.md)
  (Oxagen governs, does not run), [docs/VISION.md](../VISION.md),
  `apps/app/ARCHITECTURE.md` §3.9 (the recorder, the gate, the ledger and
  the contracts that implement ADR-055)

Paragraphs marked **Amended 2026-09-13 (ADR-055)** replace the text they
follow. ADR-055 refines ADR-052's pricing clause: the allowance is a bucket of
governed action units (GAUs) per month, more GAUs are bought in unit
quantities at the customer's contracted rate, and an organisation is either
prepaid or invoice-billed. The unit and its exclusions (§3) are unchanged.

---

## 1. Summary

ADR-052 decides *what* Oxagen bills: the governed action, with tokens reported
at zero and retention metered separately. This spec is *how* — the exact
definition the counter implements, the published rate card, the tier
allowances, the code that moves, and the migration for orgs already billed on
cost-derived credits.

Rates and allowances live here rather than in the ADR because they will move and
an accepted ADR is not edited.

**Amended 2026-09-13 (ADR-055).** The figures in §4.2 are the *published*
terms: what `pnpm billing:stripe-sync` and `seed.ts` write to `billing.plans`
(`currency`, `rate_per_gau_micros`, `block_size_gau`,
`included_gau_per_month`). A negotiated agreement is one
`billing.contract_terms` row per organisation with the same four figures, and
the effective terms for a customer are resolved on every read by
`resolveContractTerms`, never copied into the organisation. The number the
customer sees and is charged is the row's, and this table is where the
published row comes from.

---

## 2. Current state

The charge is raised at the model call, not the gate.

| Where | What happens |
|---|---|
| `packages/oxagen/src/kernel.ts` | `BillingAdmissionGateFn = (orgId) => Promise<void>` — admission only. Decides whether the org may proceed; records no unit. Skipped when the contract sets `noBillingGate: true`. |
| `packages/ai/src/*` | Calls `chargeUsageCredits(...)` after an LLM call, with the token usage. |
| `packages/billing/src/metering.ts` | `meterCreditsForUsage(usage, {markup, rateCard})` → `creditsForCostUsd(providerCostUsd(usage, rateCard), markup ?? resolveMeterMarkup())`. Credits are provider token cost, marked up. |
| `packages/billing/src/constants.ts` | Ledger reasons: `CONSUME_EXECUTION`, `CONSUME_TOOL_CALL`, `CONSUME_TOKEN_OVERAGE`. |
| `packages/billing/src/tier.ts` | `PlanTier` = `free` \| `build` \| `scale` \| `enterprise`. |
| `packages/billing/src/rate-card.ts` | Every model family priced, with cache-read and cache-write rates, kept in sync with `pricing.ts` by `rate-card-parity.test.ts`. |

Under BYOK the customer already paid the
provider, so `markup` applies margin to a cost Oxagen did not bear. And a
capability that never calls a model — most of the governance surface — is
currently free, because the only charging path runs through `@oxagen/ai`.

**Amended 2026-09-13 (ADR-055).** The state this section describes, and the
first implementation of this spec that replaced it (an annual counter in
`billing.governed_action_counters`, `plans.included_actions_annual`, overage
priced from `ACTION_RATE_BANDS` and debited from a cents credit balance by
`creditsForActions`), are both superseded by the bucket model:

| Where | What happens |
|---|---|
| `packages/billing/src/gau-bucket.ts` | `periodFor` picks the organisation's current month; `readBucket` reads the month's `billing.gau_buckets` row (or a virtual one with its carry) and never writes; `ensureCurrentBucket(tx, …)` is the one writer, an upsert on `(org_id, period_start)`. |
| `packages/billing/src/contract-terms.ts` | `resolveContractTerms(orgId)`: the effective `billing.contract_terms` row, else the entitled subscription's `billing.plans` row, else the Free plan. |
| `packages/billing/src/billing-settings.ts` | `readOrgBillingSettings(orgId)`: the org's billing mode (`approved_for_invoice_billing`, `invoice_gau_max`) and auto top-up preferences (`auto_topup_enabled`, `auto_topup_blocks`); column defaults for an org with no row, never an insert. |
| `packages/billing/src/action-metering.ts` | `recordGovernedAction` debits the bucket, runs the auto top-up (prepaid) or the interim-invoice threshold (invoice billing), and never throws. |
| `packages/billing/src/gau-settlements.ts` | `billing.gau_settlements`: every block purchase, auto top-up, interim and period-close charge as a Stripe Invoice, with `paid` the only terminal state. |
| `packages/oxagen/src/kernel.ts` | The admission gate is `assertGauAvailable`: refuses a prepaid org at `remaining ≤ 0` (`gau_exhausted`, 402) and a suspended org in either mode; never an invoice-billed org for lack of GAUs; never charges. Skipped when the contract sets `noBillingGate: true`. |
| `packages/inngest-functions/src/functions/billing.gau-close.ts` | Hourly, per org: closes ended months (period-close invoice in invoice mode) and resumes settlements Stripe never answered. |

---

## 3. The unit

### 3.1 Definition

A **governed action** is one `invoke()` that satisfies all of:

1. resolves to a registered capability,
2. is **top-level** — not nested inside another `invoke()` on the same call stack,
3. is admitted by the IAM gate and the entitlement gate,
4. executes its handler,
5. writes an audit record.

### 3.2 What does not bill

| Excluded | Why |
|---|---|
| Nested `invoke()` inside a handler | The internal call graph is an implementation detail the customer cannot see and that changes between releases. Billing it makes the invoice unpredictable. |
| `noBillingGate: true` contracts | Reading your own spend, budget, settings, membership. Never charge someone to read their bill. |
| Denied calls (IAM, entitlement, rules gate) | Billing a denial pays Oxagen more when a customer's policy is stricter. |
| Retries within one attempt | A flaky downstream is not a billable event; the logical action is. |
| Failed handler execution | If the action did not complete, there is no record to sell. |

### 3.3 Attribution

Every billable action carries `orgId`, `workspaceId`, the capability `name`, the
principal, and — where the caller supplied one — a `runId`, so a customer can
attribute a line to a team, a workspace or an agent. `runId` is metadata for
grouping, never a billing unit.

### 3.4 Runs, for quoting

Customers estimate in runs. The published conversion, to be re-derived from
production data each quarter rather than asserted:

| Run class | Typical governed actions |
|---|---|
| Q&A / lookup | 2–5 |
| Standard task | 10–20 |
| Multi-step / coding | 30–80 |
| Long-running workflow | 100+ |

Runs are used for quoting; actions are metered. The calculator that ships
with the rate card converts one to the other and shows its assumptions.

---

## 4. The rate card

### 4.1 Volume tiers

Per 1,000 governed actions, by annual volume. A customer's whole volume prices
at the band their total lands in.

| Annual governed actions | Per 1,000 |
|---|---|
| First 1M | $20 |
| 1M – 5M | $15 |
| 5M – 25M | $10 |
| 25M+ (committed) | $6 |

### 4.2 Subscription tiers and allowances

Mapping onto the `PlanTier` values that already exist:

| Tier | Platform | Included actions / yr | Evidence retention |
|---|---|---|---|
| `free` | $0 | 25k | 30 days |
| `build` | $500 / mo | 250k | 12 months |
| `scale` | $2,500 / mo | 1.5M | 12 months |
| `enterprise` | custom, committed | negotiated floor | 12 months, extensible |

Overage beyond the allowance prices at the §4.1 band.

**Amended 2026-09-13 (ADR-055).** The §4.1 bands are the published volume
rate card that `get_rate_card` and `preview_action_cost` report for quoting.
They are not the rate a customer is charged or shown on the billing page:
that figure is `rate_per_gau_micros` on the plan row or the negotiated row,
and every settlement records the rate it charged. The allowance is per month
and the bucket is one month for every organisation, so the table above is
restated:

| Tier | Platform | Included GAUs / month | Rate per GAU | Block size | Currency | Evidence retention |
|---|---|---|---|---|---|---|
| `free` | $0 | 2,000 | 20,000 micros ($20 per 1,000) | 1,000 GAU | USD | 30 days |
| `build` | $500 / mo | 20,000 | 20,000 micros ($20 per 1,000) | 1,000 GAU | USD | 12 months |
| `scale` | $2,500 / mo | 125,000 | 20,000 micros ($20 per 1,000) | 1,000 GAU | USD | 12 months |
| `enterprise` | custom, committed | negotiated (`contract_terms`) | negotiated | negotiated | negotiated | 12 months, extensible |

The per-month figures, the per-GAU rate per tier, the block size and the
currency are the design's provisional values (`apps/app/ARCHITECTURE.md`
openQuestions) until the maintainer supplies the published ones; an annual
subscriber gets the same monthly figure as a monthly subscriber, sliced on
the cycle's anniversary day. `(rate_per_gau_micros × block_size_gau)` must be
a whole number of cents (a CHECK on both tables), so a block prices without
rounding: at the figures above a block is $20.00.

Beyond the allowance:

- **Prepaid** (the default): more GAUs are bought in unit quantities of the
  block size at the contracted rate, through Checkout or by auto top-up when
  the bucket reaches `remaining ≤ 0` (`auto_topup_blocks` blocks charged to
  the saved card, at most one automatic attempt per exhaustion episode). Only
  when auto top-up cannot run is the next governed action refused.
- **Invoice billing** (`approved_for_invoice_billing`, set by a platform
  operator): consumption is never capped; overage is invoiced at the
  contracted rate at period end, or as an interim invoice for exactly
  `invoice_gau_max` GAUs (default 100,000) the day accrued uninvoiced overage
  reaches it, after which accrual restarts.

### 4.3 Retention

Twelve months of evidence included on every paid tier. Beyond that, **$0.08 per
GB-month**, billed on stored volume. This is the only meter that grows with time
rather than activity, and it is the only cost of Oxagen's that compounds.

### 4.4 Model cost: reported, billed at zero

`rate-card.ts` prices every family. The customer sees their full model spend,
per run and per capability, and is charged nothing for it. The invoice shows it as
a line item at `$0.00`; the line is not omitted.

### 4.5 Worked example

The reference customer from the seed deck: 50 agents, 20 runs per agent per
working day, 250 working days.

```
runs/yr      = 50 × 20 × 250            = 250,000
actions/yr   = 250,000 × 15             = 3,750,000   (standard-task class)
band         = 1M–5M                    → $15 / 1,000
tier         = scale                    → $30,000 / yr, 1.5M included
overage      = (3,750,000 − 1,500,000) × $15 / 1,000 = $33,750
─────────────────────────────────────────────────────────────
platform ACV                            = $63,750
```

Cross-check against the deck, which models this customer at ~$63k on a
per-run price: the ACV is unchanged; only the unit changes.

**Amended 2026-09-13 (ADR-055).** The same customer under the bucket model,
one month at a time, at the provisional `scale` terms above:

```
GAU / month     = 3,750,000 / 12                       ≈ 312,500
included        = 125,000 per month (the bucket)
overage         = 312,500 − 125,000                    = 187,500 GAU
prepaid         : 188 blocks of 1,000 GAU at $20.00    = $3,760 / month
                  (bought through Checkout or by auto top-up as the bucket
                   empties; unused purchased GAUs carry into the next month)
invoice billing : 187,500 × $0.02                      = $3,750 at period end,
                  or, with invoice_gau_max = 100,000, one interim invoice for
                  100,000 GAU the day accrued overage reaches it and a
                  period-close invoice for the remaining 87,500
```

A negotiated `contract_terms` row replaces every figure above for that
customer; nothing on the page or the invoice comes from the §4.1 band.

---

## 5. What changes in code

### 5.1 The kernel gains a recorder beside the gate

`setBillingAdmissionGate` is unchanged: admission is a separate concern from
accrual, and a gate that also bills fails open when billing is down. A sibling `setUsageRecorder` fires **after** a handler returns
successfully, receiving the attribution from §3.3.

Top-level detection uses the existing tenant-scope context: the recorder fires
only when no enclosing `invoke()` frame is present.

**Amended 2026-09-13 (ADR-055).** The recorder (`recordGovernedAction`) debits
the organisation's current month bucket through `ensureCurrentBucket(tx, …)`,
one upsert per invocation; then, for a prepaid org at `remaining ≤ 0`, claims
and runs at most one auto top-up per exhaustion episode; for an invoice-billed
org whose uninvoiced overage has reached `invoice_gau_max`, claims and cuts the
interim invoice. Every claim commits before the first Stripe call, and the
recorder never throws. The gate is `assertGauAvailable` and never charges.

### 5.2 `@oxagen/ai` stops charging

`chargeUsageCredits` call sites in `packages/ai/` become emit-only — token usage
continues to flow to ClickHouse for the §4.4 report, and raises no credit debit.
`providerCostUsd` and the rate card keep their jobs.

### 5.3 `metering.ts` splits

`meterCreditsForUsage` and `creditsForCostUsd` become reporting functions —
they still price a call, and nothing debits from them. A new
`creditsForActions(count, band)` in `action-metering.ts` is the charging path.

**Amended 2026-09-13 (ADR-055).** `creditsForActions` and the credit debit on
the governed-action path are retired. A governed action is a debit of one GAU
from the month's bucket, and money moves only in `billing.gau_settlements`
(a block purchase, an auto top-up, an interim or a period-close invoice), each
a Stripe Invoice. The credit ledger keeps its remaining caller, the
ADR-053 platform-funded assistant turn.

**`resolveMeterMarkup` survives, narrowed.** This paragraph originally deleted
it, on the reasoning that under BYOK there is no cost to mark up. ADR-053 §3,
accepted the following day, amends ADR-052 for one case: tokens the
in-app agent spent on the **platform** key are a cost Oxagen did bear, and are
billed back "at the rate card's vendor cost plus a published markup" under
`consume_assistant_tokens`. Deleting the markup would delete the rate ADR-053
requires. It keeps its name and its env resolution, and its only remaining
charging caller is the platform-funded assistant path.

### 5.4 Ledger reasons

`CONSUME_EXECUTION` and `CONSUME_TOOL_CALL` survive and take on the action meter.
`CONSUME_TOKEN_OVERAGE` is **retired, not repurposed** — historical rows keep
meaning what they meant. A new `CONSUME_RETENTION` covers §4.3.

### 5.5 No re-bill layer

Oxagen sells direct to the enterprise team that runs the agents and answers for
them. There is no margin line, so there is nothing to resell: the reseller
capabilities, tables, pricing modes and the Billing → Revenue surface were
deleted rather than repointed at the action meter. Price is set by tier
allowance plus per-action overage, and an org that reaches its allowance either
moves up a tier or buys ad-hoc usage.

**Amended 2026-09-13 (ADR-055).** Price is a monthly bucket of included GAUs
plus GAUs bought in unit quantities at the customer's contracted rate. An org
that reaches its allowance buys blocks (or auto top-up buys them), or, when a
platform operator has approved it for invoice billing, keeps running and is
invoiced for the overage. There is no ad-hoc dollar purchase on the
governed-action path.

### 5.6 Surfaces

Per the capability-parity and UI-parity rules: the rate card, the current
period's action count, the run→action calculator, and the retention figure each
need a contract, an API route, an MCP tool and a real page in `apps/app`. A
customer must be able to see what they are being charged for in the product,
not only on an invoice.

**Amended 2026-09-13 (ADR-055).** The billing page shows, in the customer's
units: the plan (`get_subscription`), the billing mode and the month's bucket
(`get_gau_bucket`: included, purchased, carried, used, remaining — GAU counts,
never money), the auto top-up setting (`set_auto_topup`), the contracted rate
with its source and the block price (`get_contract_rate`), a block purchase in
GAUs (`purchase_gau_bucket` → Stripe Checkout), and the invoices with a kind
per row (`list_invoices`). `set_org_billing_terms` is platform-operator only
and has no surface. `get_action_usage` is retired with the dollar model it
reported. The rate card (`get_rate_card`) and the calculator
(`preview_action_cost`) stay contracts on API and MCP; the retention figure
(`get_evidence_retention`) is unmeasured for every organisation and is not on
the page.

---

## 6. Migration

1. **Shadow.** Record actions and continue charging cost-derived credits. Both
   numbers land in ClickHouse; nobody's bill moves.
2. **Compare.** One full billing period. For every org, publish action-priced
   versus cost-priced. The distribution of the delta is the input to the final
   rates in §4.1; the numbers there are provisional until the comparison.
3. **Notify.** Every org sees both numbers in-product for a period before the
   switch. Orgs whose bill rises are contacted individually.
4. **Cut over.** Action pricing becomes the charging path. Cost-derived pricing
   remains as the §4.4 report.
5. **Grandfather.** Existing annual contracts run to term on their signed terms.

Step 2 is a gate: if the comparison shows the rates are wrong, the rates change
before the cut-over.

**Amended 2026-09-13 (ADR-055).** The shadow, compare and notify steps are
retired with `OXAGEN_ACTION_METER_MODE`: a shadow that charged a card or cut
an invoice would not be a shadow, and one that did neither would leave a
prepaid org running past exhaustion with no record. This is the zero-customer
window; the bucket model is the charging path from the day it lands and no
billed history is migrated. Token cost is still priced in full and reported at
zero (§4.4).

---

## 7. Open questions — answered

Answered 2026-09-10 under [SCR-002](../scr/SCR-002-durability-first-architecture.md)
(choose the durable option and record it, rather than hold the work). Each answer
names what would have to change to revisit it.

### 7.1 An async capability bills on dispatch

A `mode: "async"` capability returns immediately and finishes later. §7 originally
leaned toward billing on completion. It bills on **dispatch**, because of ADR-043:
Oxagen governs agents and does not run them. The governed action is the gate
decision plus the durable record, and both happen at dispatch: the gates run and
the audit row is written there. Billing on completion would make Oxagen's meter
depend on execution it disclaims owning, and would need the recorder to survive an Inngest
boundary where a dropped event silently means a free action.

A dispatched job that never
completes is a reliability defect, refunded through the `adjustment` ledger reason
that already exists.

**Revisit if** Oxagen ever executes the deferred work itself, which would make ADR-043 the
thing to change first.

### 7.2 Ingestion bills per batch of records, through one meter

A connector pull is one `invoke()` that may write a million graph nodes.
Per-sync under-prices it by orders of magnitude. §7 raised a third meter; there
is **no third meter and no second unit**. A contract may declare how many
governed actions one invocation represents:

```ts
meter: {
  unitsFrom: "recordsIngested",  // output field carrying the sub-unit count
  unitsPerAction: 100,           // sub-units that make one governed action
}
```

Actions charged = `max(1, ceil(units / unitsPerAction))`, and a contract without a
`meter` block bills exactly one, which is every contract today. The unit stays
"governed action", the invoice stays one number, and the exception is declared on
the contract where a reader can see it rather than living in the biller.

`unitsFrom` reads the **validated output**, so a handler cannot inflate or deflate a
charge with a field the contract does not declare.

**Revisit if** a sub-unit appears whose cost differs in kind rather than
in count, which is what would justify a third meter.

### 7.3 The enterprise floor stays negotiated, and becomes recorded

§4.2 said "negotiated", which in code meant absent — and an absent allowance is
indistinguishable from an unlimited one. A published floor is a commercial number,
so this spec does not set one.

The architectural half is fixed: an enterprise allowance is a
**required, stored value** on the subscription's plan row, and the meter refuses
to treat a missing one as unlimited. It falls back to the `scale` allowance and
logs, so a mis-provisioned enterprise org under-bills by a bounded amount instead
of running free.

**Revisit if** a published enterprise floor is set; only the constant moves.

**Amended 2026-09-13 (ADR-055).** An enterprise allowance is
`included_gau_per_month` on the organisation's `billing.contract_terms` row,
with its rate, block size and currency, and the row is the whole answer.
`plans.included_actions_annual` and the `scale` fallback are retired: an
enterprise org with no effective negotiated row resolves to the published
terms of the plan its subscription names, like every other org.

### 7.4 Retention beyond twelve months is opt-in

Extended retention is **off by default**, so no storage charge accrues on evidence
a customer forgot they were keeping: past twelve months, evidence ages out under the organisation's
retention policy and no charge accrues. An organisation that opts in is charged
§4.3 on stored volume, and sees the figure in-product before the first bill.

### 7.5 Shadow-then-compare ordering is confirmed, with one change

The §6 ordering stands and the comparison is a gate on the rates. One change:
the comparison does **not** need a period in which both meters charge, only a
period in which both are *computed*. Token cost keeps being priced in full under
§4.4 and reported at zero, and the action count is recorded from the moment the
recorder lands, so the §6 step-2 comparison is computable over any window either
side of the cut-over.

`OXAGEN_ACTION_METER_MODE=shadow` records actions and raises no debit, for a
staged rollout. It defaults to `charge`, because the interval between
`@oxagen/ai` giving up the markup and the action meter taking over is an interval
in which the platform bills nothing at all.

**Amended 2026-09-13 (ADR-055).** `OXAGEN_ACTION_METER_MODE` and
`resolveActionMeterMode` are deleted; see the §6 amendment.

---

## 8. Traceability

| Decision | Implementation |
|---|---|
| §3.1 top-level only | `packages/oxagen/src/kernel.ts` — `_governedActionScope` AsyncLocalStorage |
| §3.2 exclusions | same file — `noBillingGate`, denial (recorder is past the throw), failed handler, invalid output |
| §3.3 attribution | `GovernedActionRecord` |
| §4.1 bands (quoting only, ADR-055) | `packages/billing/src/action-metering.ts` — `ACTION_RATE_BANDS`, read by `get_rate_card` and `preview_action_cost` |
| §4.2 published terms (ADR-055) | `billing.plans` (`currency`, `rate_per_gau_micros`, `block_size_gau`, `included_gau_per_month`) written by `seed.ts` and `pnpm billing:stripe-sync`; negotiated terms in `billing.contract_terms`; resolved by `packages/billing/src/contract-terms.ts` |
| §4.2 the month bucket (ADR-055) | `packages/billing/src/gau-bucket.ts` — `periodFor`, `readBucket`, `ensureCurrentBucket`; `billing.gau_buckets` |
| §4.2 the two modes (ADR-055) | `billing.org_billing_settings` — `approved_for_invoice_billing`, `invoice_gau_max`, `auto_topup_enabled`, `auto_topup_blocks`; `packages/billing/src/billing-settings.ts` — `readOrgBillingSettings`; `set_org_billing_terms`, `set_auto_topup` |
| §4.2 settlements (ADR-055) | `packages/billing/src/gau-settlements.ts`; `billing.gau_settlements`; `BillingProvider.createGauCheckout`, `createGauInvoice`, `finalizeAndPayGauInvoice`, `deleteOrVoidDraftInvoice`; `billing.gau-close` (hourly) |
| §4.3 retention | `packages/billing/src/action-metering.ts` — `RETENTION_USD_PER_GB_MONTH`, `CREDIT_REASONS.CONSUME_RETENTION`; no charger in rev1 (`chargeEvidenceRetention` deleted, ADR-055 §12) |
| §4.4 reported at zero | `packages/ai/src/*` charge sites, gated on `fundedBy === "platform"` (ADR-053 §3) |
| §7.2 multi-unit | contract `meter` block, read in the kernel from validated output |
| §7.5 shadow | retired (ADR-055) |
