# Governed-action metering — the meter, the rate card, and the move off cost-derived credits

- **Status:** Accepted
- **Date:** 2026-09-08 (open questions answered 2026-09-10; amended
  2026-09-13 for ADR-055; v1 rates set 2026-09-14; maintainer decisions
  of 2026-09-15 recorded in §4.2, §5.6, §6, §7.2, §7.3 and §7.5)
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
follow. The figures in §4 are the v1 rates the maintainer set on 2026-09-14;
they replace the provisional figures the ADR-055 amendment carried (2,000 /
20,000 / 125,000 GAU a month, 20,000 micros per GAU, 1,000-GAU blocks) and
the per-year table that preceded them. ADR-055 refines ADR-052's pricing clause: the allowance is a bucket of
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
| `packages/oxagen/src/kernel.ts` | The admission gate is `assertGauAvailable`: refuses a prepaid org at `remaining ≤ 0` (`gau_exhausted`, 402; for a Free org with no default payment method the error carries `reason: "free_no_payment_method"`) and a suspended org in either mode; never an invoice-billed org for lack of GAUs; never charges. Skipped when the contract sets `noBillingGate: true`. |
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

**Amended 2026-09-23 (ADR-158).** The attribution is now stored, not only
carried. Before this amendment the billing bootstrap passed four fields to the
recorder, which counted the action in `billing.gau_buckets` and logged the rest.
Every billed action is now a row in `billing.gau_ledger`, written in the same
transaction as the bucket debit. Each row records:

- the source (`kernel`, `tacho` or `external_tool`);
- the capability or tool, and the MCP server;
- the surface and the harness;
- the workspace, the agent, the principal and the operator;
- the run, the session, the tool call and the request;
- the units, when the action happened (`occurred_at`) and when it was billed
  (`billed_at`).

A field the source did not know is null, never invented. Statements
(`get_billing_statement`, `export_billing_statement`) read these rows, so an
invoice line reconciles to the actions behind it by addition.

The retry exclusion in §3.2 is implemented by the ledger's
`(org_id, idempotency_key)` unique index. The key is taken from the tool-call id,
the Tacho tool-use id or the lifecycle idempotency key, and a row that is
already on the ledger debits nothing. An invocation with no stable name for its
logical action gets a key of its own and is not deduplicated.

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
at the band their total lands in. v1 rates, set 2026-09-14:

| Annual governed actions | Per 1,000 | Per GAU |
|---|---|---|
| First 1M | $5 | 5,000 micros |
| 1M – 5M | $4 | 4,000 micros |
| 5M – 25M | $3 | 3,000 micros |
| 25M+ (committed) | $2 | 2,000 micros |

The first band is the list rate: 5,000 micros per GAU, and the rate every
published tier carries (§4.2). `ACTION_RATE_BANDS` in
`packages/billing/src/action-metering.ts` is this table, and `get_rate_card`
and `preview_action_cost` report it for quoting.

### 4.2 Subscription tiers and allowances

Mapping onto the `PlanTier` values that already exist. The §4.1 bands are the
published volume rate card that `get_rate_card` and `preview_action_cost`
report for quoting. They are not the rate a customer is charged or shown on
the billing page: that figure is `rate_per_gau_micros` on the plan row or the
negotiated row, and every settlement records the rate it charged (ADR-055).
The allowance is per month and the bucket is one month for every
organisation. v1 rates, set by the maintainer 2026-09-14:

| Tier | Platform | Included GAUs / month | Rate per GAU | Block size | Currency | Evidence retention | Past the allowance |
|---|---|---|---|---|---|---|---|
| `free` | $0 | 5,000 | 5,000 micros ($5 per 1,000) | 5,000 GAU ($25.00) | USD | 30 days | refused until the org saves a card or the next month opens; with a saved card, auto top-up at list |
| `build` | $199 / mo | 50,000 | 5,000 micros ($5 per 1,000) | 5,000 GAU ($25.00) | USD | 12 months | auto top-up at list |
| `scale` | $999 / mo | 300,000 | 5,000 micros ($5 per 1,000) | 5,000 GAU ($25.00) | USD | 12 months | auto top-up at list; invoice billing eligible |
| `enterprise` | committed annual, negotiated | negotiated (`billing.contract_terms`) | negotiated: $2.50 – $3.00 per 1,000 at ≥ 5M / year | negotiated | USD | 12 months, extensible | invoice billing |

These figures are the published terms `billing.plans` carries
(`rate_per_gau_micros`, `block_size_gau`, `included_gau_per_month`,
`currency`; WL-24 seeds them). An annual subscriber gets the same monthly
figure as a monthly subscriber, sliced on the cycle's anniversary day. The
`enterprise-v2` plan row (`packages/billing/src/pricing.ts`, written to
`billing.plans` by `billing:stripe-sync`) carries the `scale` figures
(300,000 GAU a month, 5,000 micros per GAU, 5,000-GAU blocks, USD); they
apply to an enterprise organisation only while it has no effective
`billing.contract_terms` row (§7.3), and a negotiated agreement replaces all
four figures at once. `(rate_per_gau_micros × block_size_gau)` must be a
whole number of cents (a CHECK on both tables), so a block prices without
rounding: 5,000 micros × 5,000 GAU = $25.00.

**Amended 2026-09-15 (maintainer decision 3).** Enterprise is negotiated
only. `enterprise-v2` is removed from `SUBSCRIPTION_PLANS` and from the
Stripe catalogue (WL-56), and an enterprise organisation's terms are its
`billing.contract_terms` row. The `enterprise` row of the table above and
the `enterprise-v2` sentence before this paragraph describe the tree until
WL-56 lands. No feature is gated on the enterprise licence: every feature,
IAM and the SOC 2 controls included, is on for every tier (ADR-055 §2,
WL-55).

**Free saves a card or waits (maintainer, 2026-09-14).** A Free org that
exhausts its monthly allowance (5,000 GAU) is refused further governed actions
(`gau_exhausted` / 402) until either (a) the next monthly period opens a new
allowance, or (b) the org saves a payment method. Saving a card is the gate,
not a purchase: once a card is on file, the org behaves like a prepaid org —
auto top-up (enabled by default, `auto_topup_blocks = 1`) charges the saved
card for a 5,000-GAU block at the list rate and consumption continues; manual
block purchase through Checkout is also available. A Free org with no saved
card cannot auto top-up; the refusal carries `reason: "free_no_payment_method"`,
and the exhausted state on the billing page and in the approval dialog says
"Add a payment method to keep governing this month, or your allowance renews
on <date>". The first block purchase (Checkout collects the card with
`setup_future_usage: "off_session"`, so the purchase is itself a card-saving
path and is offered to a Free org with no card) or a SetupIntent
(`createPaymentMethodSetupIntent`, `packages/billing/src/payment-methods.ts`)
saves the card as the default payment method. The maintainer's words: "they
should be required to save a card after they burn through free tier once or
they must wait for the next month." The paid tiers auto top-up at the list
rate; `scale` and `enterprise` may be approved for invoice billing.

The previous figures, for the record: the per-year table this section first
carried (25k / 250k / 1.5M a year at $0 / $500 / $2,500 a month) and the
ADR-055 amendment's provisional per-month figures (2,000 / 20,000 / 125,000
GAU at 20,000 micros per GAU in 1,000-GAU blocks, a $20.00 block). Nothing
was billed at either.

Beyond the allowance:

- **Prepaid** (the default): more GAUs are bought in unit quantities of the
  block size at the contracted rate, through Checkout or by auto top-up when
  the bucket reaches `remaining ≤ 0` (`auto_topup_blocks` blocks charged to
  the saved card, at most one automatic attempt per exhaustion episode). Only
  when auto top-up cannot run is the next governed action refused. A Free org
  is prepaid with no saved card until its first Checkout or SetupIntent saves
  one, so it is refused at exhaustion until it saves a card or the month
  renews (the dated rule above).
- **Invoice billing** (`approved_for_invoice_billing`, set by a platform
  operator): consumption is never capped; overage is invoiced at the
  contracted rate at period end, or as an interim invoice for exactly
  `invoice_gau_max` GAUs (default 100,000) the day accrued uninvoiced overage
  reaches it, after which accrual restarts.
  **Amended 2026-09-15 (maintainer decisions 5, 6 and 12).**
  - `invoice_gau_max` limits overage beyond the monthly allowance. The
    interim invoice fires at overage unit `invoice_gau_max`+1 and invoices
    exactly `invoice_gau_max` GAUs, and that extra unit starts the next
    accrual. On `build` with the default cap, that is GAU #150,001 of the
    month.
  - An invoice-billed organisation is suspended 5 days after an interim or
    period-close invoice is past due. Metering continues while it is
    suspended, and paying the full outstanding balance reactivates it.
  - When invoice billing is switched off, the invoiced overage is added to
    `purchased_gau`: the invoice is the purchase.

  ADR-055 §7 carries all three.

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
working day, 250 working days. The calculator's quote, at the v1 §4.1 band:

```
runs/yr      = 50 × 20 × 250            = 250,000
actions/yr   = 250,000 × 15             = 3,750,000   (standard-task class)
band         = 1M–5M                    → $4 / 1,000
tier         = scale                    → $11,988 / yr, 300,000 / month
                                          (3.6M / yr) included
overage      = (3,750,000 − 3,600,000) × $4 / 1,000 = $600
─────────────────────────────────────────────────────────────
platform ACV (quote)                    = $12,588
```

The seed deck priced this customer at ~$63k on the pre-v1 per-run figures;
at v1 the platform line is ~$12.6k and the customer's model spend, reported
at $0.00 (§4.4), is the larger number by design (§4.6).

**Amended 2026-09-13 (ADR-055).** The same customer under the bucket model,
one month at a time, at the published `scale` terms above (the quote's band
rate applies only through a negotiated `contract_terms` row; a published
tier settles at its plan rate, 5,000 micros):

```
GAU / month     = 3,750,000 / 12                       ≈ 312,500
included        = 300,000 per month (the bucket)
overage         = 312,500 − 300,000                    = 12,500 GAU
prepaid         : 3 blocks of 5,000 GAU at $25.00      = $75 / month
                  (bought through Checkout or by auto top-up as the bucket
                   empties; the 2,500 unused purchased GAUs carry into the
                   next month)
invoice billing : 12,500 × $0.005                      = $62.50 at period end;
                  with invoice_gau_max = 100,000 no interim invoice fires,
                  because accrued overage never reaches the cap in a month
```

A negotiated `contract_terms` row replaces every figure above for that
customer; nothing on the page or the invoice comes from the §4.1 band.

### 4.6 Why these figures (v1, 2026-09-14)

- A coding run is 30–80 governed actions (§3.4), so at $5 per 1,000 a run
  costs $0.15 – $0.40, about 10 – 15% of the model spend the same run
  reports at $0.00 (§4.4). The platform line is priced to sit beside the
  model bill, not to compete with it.
- The marginal cost of a GAU (the kernel invoke, the evidence write, the
  ClickHouse row) is under $0.001, so margin exceeds 85% at every band. At
  the $2 committed band that holds for a marginal cost at or below $0.0003
  per GAU, which is within the estimate.
- Retention beyond 12 months bills per GB-month (§4.3, ADR-052); it is not
  folded into the GAU rate.
- Free stops at exhaustion until the org saves a card or the next month
  opens: the tier is for evaluation, and its 5,000 GAU a month is roughly
  60 – 165 coding runs. Saving a card, not upgrading, is what lets a Free org
  keep going in the same month; from then on it is a prepaid org on Free's
  published terms.

### 4.7 Two meters (maintainer, 2026-09-15)

Oxagen charges on two meters, and they share no balance.

| Meter | Unit | Price | Funded by | Charged on |
|---|---|---|---|---|
| Governed actions | governed action unit (GAU) | list $5 per 1,000 (5,000 micros per GAU); 5,000-GAU blocks at $25; volume bands $5 / $4 / $3 / $2 per 1,000 (§4.1) | the month's included GAUs (Free 5,000; Build $199 a month, 50,000; Scale $999 a month, 300,000; Enterprise negotiated on `billing.contract_terms`), then blocks bought or auto top-up, or invoice billing (§4.2) | `resolve_approval`, the billable governed action (`apps/app/ARCHITECTURE.md` §1.5); membership writes and every `noBillingGate` read are free |
| In-app AI usage | usage credit, 1 credit = $0.01 | the provider cost of each of the in-app agent's model calls times the meter markup (`resolveMeterMarkup`, `packages/billing/src/pricing.ts`) | the $5 signup grant `create_org` writes, then credit packs bought through `purchase_credits` | the credit gate on the in-app agent's platform-paid turns (`packages/billing/src/turn-credit-gate.ts`, ADR-053 §3) |

Every feature is on every tier; the tiers differ in platform price, included
GAUs and evidence retention (§4.2). Tokens are not passed through at cost: the
in-app agent's platform-paid calls carry the markup, and the model spend of a
customer's own agents stays reported at $0.00 (§4.4). Proven spend is a report
figure on neither meter. Credits never buy GAUs, and a GAU block never adds
credits. The billing page shows both meters: the GAU bucket with the
contracted rate, and the usage credit balance with a top-up
(`apps/app/ARCHITECTURE.md` §1.4).

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
one upsert per invocation; then, for a prepaid org at `remaining ≤ 0` with a
saved default payment method (a Free org has none until it saves one), claims
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
requires. It keeps its name and its env resolution, and it has a second
charging caller beyond the assistant path: platform-paid embeddings, under
`consume_embedding`.

**Amended 2026-09-18 (ADR-053).** The markup on `consume_assistant_tokens`
is fixed at `ASSISTANT_TOKEN_MARKUP` (1, cost with no margin), not
`resolveMeterMarkup()`. `chargeCostUsd` branches on the ledger reason before
falling back to the solved markup, so `consume_embedding` is unaffected and
keeps the number `resolveMeterMarkup` returns. `resolveMeterMarkup` is
therefore no longer read on the assistant path at all. Its remaining
charging caller is `consume_embedding`.

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
governed-action path. A Free org with no saved card is refused at exhaustion
until it saves one or the next month opens (§4.2, 2026-09-14).

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

**Amended 2026-09-15 (maintainer decision 7).** `get_rate_card`,
`preview_action_cost` and `get_evidence_retention` retire at cutover:
`apps/app/architecture.worklist.json` WL-50 deletes their contracts, routes,
MCP tools and docs, so the rate card and the calculator stop being contracts
on API and MCP. `start_subscription_upgrade` stays, and the billing page
binds it as an in-app Build/Scale upgrade through Stripe Checkout (WL-66).

---

## 6. Migration

1. **Shadow.** Record actions and continue charging cost-derived credits. Both
   numbers land in ClickHouse; nobody's bill moves.
2. **Compare.** One full billing period. For every org, publish action-priced
   versus cost-priced. The distribution of the delta is the check on the
   v1 rates in §4.1 (set 2026-09-14); a delta that argues for moving them is
   a maintainer decision, recorded here with a date.
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

**Amended 2026-09-15: shadow period waived (maintainer decision 14).** The
maintainer skipped the metering shadow period, and the waiver is dated
2026-09-15. Steps 1–3 (shadow, compare, notify) do not run: action pricing
is the charging path from the day the bucket model landed. Step 5's
grandfathering has no contract to apply to in the zero-customer window.
`apps/app/ARCHITECTURE.md` §9 and ADR-055 §15 record the decision.

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

### 7.2 An ingestion invocation bills one governed action; the multi-unit `meter` block is built and unused

**Amended 2026-09-15.** The heading this section carried, "Ingestion bills
per batch of records, through one meter", described a mechanism no contract
uses. #2873 found the contradiction with §7.1. It was closed in the
2026-09-13 tracker reset as absorbed by the GAU bucket model, and the text
was never changed. What is built:

- **The mechanism.** The kernel reads a contract's `meter` block against the
  validated output (`governedActionUnits`, `packages/oxagen/src/kernel.ts`;
  the `meter` field in `packages/oxagen/src/types.ts`), and
  `kernel.usage-recorder.test.ts` covers it.
- **No contract declares one.** `rg -n 'meter:' packages/oxagen/src/contracts`
  is empty, so every invocation bills exactly one GAU.
- **Async sync contracts.** `sync_integration` and `sync_repo` are
  `mode: "async"` and bill one GAU at dispatch under §7.1. Their output is a
  dispatch receipt with no record count. `sync_repo`'s `estimatedRecords` is
  an estimate and is never billed on.
- **Tacho ingest.** `ingest_tacho_events` is `noBillingGate: true`: recording
  a run is not a governed action.
  **Amended 2026-09-23 (ADR-158, maintainer decision).** Recording a run is
  still not a governed action, and the admission gate never refuses one. Each
  tool call in the batch that a wrapped harness made and Tacho allowed is now one
  governed action. The ingest records it on the ledger with source `tacho`, keyed
  on the session and the tool-use id, so a re-sent batch bills nothing new.
  Denials stay free. External MCP tool calls that Oxagen authorises bill one
  governed action each with source `external_tool`.

A contract that later declares a `meter` block must name a validated output
field carrying a count of work already done. The original text follows.

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
`plans.included_actions_annual` and the `scale` fallback in code are retired:
an enterprise org with no effective negotiated row resolves to the published
terms of the plan its subscription names, like every other org. For the
`enterprise-v2` plan those are the §4.2 `enterprise` row, which
`billing:stripe-sync` writes to `billing.plans` with the same figures as
`scale` (300,000 GAUs a month, 5,000 micros per GAU, 5,000-GAU blocks, USD;
v1 rates set 2026-09-14). The bound this section set is kept by the stored row rather
than by a fallback branch: a mis-provisioned enterprise org meters at the
`scale` figures, and the four columns are NOT NULL so no plan row can be
absent.

**Amended 2026-09-15 (maintainer decision 3).** Enterprise is negotiated
only. `enterprise-v2` leaves `SUBSCRIPTION_PLANS` and the Stripe catalogue
(`apps/app/architecture.worklist.json` WL-56). After that, an enterprise
organisation's `billing.contract_terms` row is the only source of its terms,
and no `billing.plans` row sells enterprise. The stored-row bound above
still covers an organisation whose subscription names the hidden
`enterprise-v2` row and has no negotiated row. No feature is gated on the
enterprise licence: every feature, IAM and the SOC 2 controls included, is
on for every tier (ADR-055 §2, WL-55).

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

**Amended 2026-09-15 (maintainer decision 14).** The shadow period is
skipped, with a waiver dated 2026-09-15 (§6). The comparison this section
describes is still computable over any window, because token cost is still
priced in full (§4.4). It is no longer a gate on the cut-over.

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
| §7.2 multi-unit | contract `meter` block, read in the kernel from validated output (`governedActionUnits`); no contract declares one, so every invocation bills one GAU (amended 2026-09-15) |
| §7.3 enterprise | `billing.contract_terms`; `enterprise-v2` leaves `SUBSCRIPTION_PLANS` (WL-56); no tier gate (WL-55) (maintainer decision, 2026-09-15) |
| §6, §7.5 shadow | retired (ADR-055); shadow period waived 2026-09-15 (maintainer decision) |
