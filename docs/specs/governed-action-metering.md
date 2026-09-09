# Governed-action metering — the meter, the rate card, and the move off cost-derived credits

- **Status:** Proposed
- **Date:** 2026-09-08
- **Author:** platform
- **Related:** [ADR-052](../adr/ADR-052-governed-action-as-the-billable-unit.md)
  (the decision), [ADR-042](../adr/ADR-042-tenant-data-planes.md)
  (organisation data planes), [ADR-043](../adr/ADR-043-runtime-excision.md)
  (Oxagen governs, does not run), [docs/VISION.md](../VISION.md)

---

## 1. Summary

ADR-052 decides *what* Oxagen bills: the governed action, with tokens reported
at zero and retention metered separately. This spec is *how* — the exact
definition the counter implements, the published rate card, the tier
allowances, the code that moves, and the migration for orgs already billed on
cost-derived credits.

Rates and allowances live here rather than in the ADR because they will move and
an accepted ADR is not edited.

---

## 2. Current state

The charge is raised at the model call, not the gate.

| Where | What happens |
|---|---|
| `packages/oxagen/src/kernel.ts` | `BillingAdmissionGateFn = (orgId) => Promise<void>` — admission only. Decides whether the org may proceed; records no unit. Skipped when the contract sets `noBillingGate: true`. |
| `packages/ai/src/*` | Calls `chargeUsageCredits(...)` after an LLM call, with the token usage. |
| `packages/billing/src/metering.ts` | `meterCreditsForUsage(usage, {markup, rateCard})` → `creditsForCostUsd(providerCostUsd(usage, rateCard), markup ?? resolveMeterMarkup())`. Credits are provider token cost, marked up. |
| `packages/billing/src/constants.ts` | Ledger reasons: `CONSUME_EXECUTION`, `CONSUME_TOOL_CALL`, `CONSUME_TOKEN_OVERAGE`. |
| `packages/billing/src/reseller-pricing.ts` | Two modes already: `markup` (bps over raw cost) and `per_unit` (flat cents per metered unit, cost-independent). |
| `packages/billing/src/tier.ts` | `PlanTier` = `free` \| `build` \| `scale` \| `enterprise`. |
| `packages/billing/src/rate-card.ts` | Every model family priced, with cache-read and cache-write rates, kept in sync with `pricing.ts` by `rate-card-parity.test.ts`. |

Two consequences worth stating plainly. Under BYOK the customer already paid the
provider, so `markup` applies margin to a cost Oxagen did not bear. And a
capability that never calls a model — most of the governance surface — is
currently free, because the only charging path runs through `@oxagen/ai`.

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
principal, and — where the caller supplied one — a `runId`, so a reseller can
attribute a slice to an end customer and a customer can attribute a line to a
team. `runId` is metadata for grouping, never a billing unit.

### 3.4 Runs, for quoting

Customers estimate in runs. The published conversion, to be re-derived from
production data each quarter rather than asserted:

| Run class | Typical governed actions |
|---|---|
| Q&A / lookup | 2–5 |
| Standard task | 10–20 |
| Multi-step / coding | 30–80 |
| Long-running workflow | 100+ |

**A run is a quoting device. An action is the meter.** The calculator that ships
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

### 4.3 Retention

Twelve months of evidence included on every paid tier. Beyond that, **$0.08 per
GB-month**, billed on stored volume. This is the only meter that grows with time
rather than activity, and it is the only cost of Oxagen's that compounds.

### 4.4 Model cost: reported, billed at zero

`rate-card.ts` prices every family. The customer sees their full model spend,
per run and per capability, and is charged nothing for it. This is a line item
on the invoice showing `$0.00`, not an absent line — the zero is the message.

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
per-run price: the ACV is unchanged, the unit is better. **Repricing the meter
does not reprice the deck.**

---

## 5. What changes in code

### 5.1 The kernel gains a recorder beside the gate

`setBillingAdmissionGate` stays exactly as it is — admission is a separate
concern from accrual, and a gate that also bills is a gate that fails open when
billing is down. A sibling `setUsageRecorder` fires **after** a handler returns
successfully, receiving the attribution from §3.3.

Top-level detection uses the existing tenant-scope context: the recorder fires
only when no enclosing `invoke()` frame is present.

### 5.2 `@oxagen/ai` stops charging

`chargeUsageCredits` call sites in `packages/ai/` become emit-only — token usage
continues to flow to ClickHouse for the §4.4 report, and raises no credit debit.
`providerCostUsd` and the rate card keep their jobs.

### 5.3 `metering.ts` splits

`meterCreditsForUsage` and `creditsForCostUsd` move behind a reporting namespace.
A new `creditsForActions(count, band)` becomes the charging path. `resolveMeterMarkup`
loses its charging caller and is deleted rather than left dangling — under BYOK
there is no cost to mark up.

### 5.4 Ledger reasons

`CONSUME_EXECUTION` and `CONSUME_TOOL_CALL` survive and take on the action meter.
`CONSUME_TOKEN_OVERAGE` is **retired, not repurposed** — historical rows keep
meaning what they meant. A new `CONSUME_RETENTION` covers §4.3.

### 5.5 Reseller

No change. `priceAttributedUsage` in `per_unit` mode is `unitPriceCents × quantity`
with `quantity` = governed actions. The mode exists; this makes it the default
for new reseller plans. `markup` mode stays for partners who resell their own
model spend.

### 5.6 Surfaces

Per the capability-parity and UI-parity rules: the rate card, the current
period's action count, the run→action calculator, and the retention figure each
need a contract, an API route, an MCP tool and a real page in `apps/app`. A
customer must be able to see what they are being charged for in the product,
not only on an invoice.

---

## 6. Migration

1. **Shadow.** Record actions and continue charging cost-derived credits. Both
   numbers land in ClickHouse; nobody's bill moves.
2. **Compare.** One full billing period. For every org, publish action-priced
   versus cost-priced. The distribution of the delta is the input to the final
   rates in §4.1 — the numbers there are a starting point, not a result.
3. **Notify.** Every org sees both numbers in-product for a period before the
   switch. Orgs whose bill rises are contacted individually.
4. **Cut over.** Action pricing becomes the charging path. Cost-derived pricing
   remains as the §4.4 report.
5. **Grandfather.** Existing annual contracts run to term on their signed terms.

Step 2 is a gate, not a formality: if the comparison shows the rates are wrong,
the rates change before the cut-over, not after.

---

## 7. Open questions

1. **Does an async capability bill on dispatch or on completion?** A `mode: "async"`
   capability returns immediately and finishes later. Billing on dispatch is simpler
   and bills work that may fail; billing on completion is correct and needs the
   recorder to survive an Inngest boundary. Leaning completion.
2. **Does an ingestion sync bill per record or per sync?** A connector pull is one
   `invoke()` that may write a million graph nodes. Per-sync under-prices it badly.
   Ingestion may need its own unit, which would make three meters, not two.
3. **What is the floor on `enterprise`?** §4.2 says "negotiated"; a published floor
   would be more honest and harder to discount away.
4. **Retention beyond twelve months — opt-in or default?** Silently accruing
   storage charges on evidence a customer forgot they were keeping is the kind of
   surprise this whole design is trying to avoid.
