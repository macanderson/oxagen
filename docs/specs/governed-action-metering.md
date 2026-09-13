# Governed-action metering — the meter, the rate card, and the move off cost-derived credits

- **Status:** Accepted
- **Date:** 2026-09-08 (open questions answered 2026-09-10)
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

`meterCreditsForUsage` and `creditsForCostUsd` become reporting functions —
they still price a call, and nothing debits from them. A new
`creditsForActions(count, band)` in `action-metering.ts` is the charging path.

**`resolveMeterMarkup` survives, narrowed.** This paragraph originally deleted
it, on the reasoning that under BYOK there is no cost to mark up. ADR-053 §3,
accepted the following day, amends ADR-052 for exactly one case: tokens the
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

## 7. Open questions — answered

Answered 2026-09-10 under [SCR-002](../scr/SCR-002-durability-first-architecture.md)
(choose the durable option and record it, rather than hold the work). Each answer
names what would have to change to revisit it.

### 7.1 An async capability bills on dispatch

A `mode: "async"` capability returns immediately and finishes later. §7 originally
leaned toward billing on completion. **Dispatch is the answer**, because ADR-043
decides it: Oxagen governs agents and does not run them. The governed action is
the gate decision plus the durable record, and both happen at dispatch — the gates
ran there, the audit row was written there, and that is the entire thing being
sold. Billing on completion would make Oxagen's meter depend on execution it
explicitly disclaims owning, and would need the recorder to survive an Inngest
boundary where a dropped event silently means a free action.

The failure case is handled where failures belong. A dispatched job that never
completes is a reliability defect, refunded through the `adjustment` ledger reason
that already exists — not silently absorbed by the meter.

**Revisit if** Oxagen ever executes the deferred work itself, which would make ADR-043 the
thing to change first.

### 7.2 Ingestion bills per batch of records, through one meter

A connector pull is one `invoke()` that may write a million graph nodes.
Per-sync under-prices it by orders of magnitude. §7 raised a third meter; the
answer is **no third meter and no second unit** — a contract may declare how many
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

**Revisit if** a sub-unit appears whose cost genuinely differs in kind rather than
in count, which is what would justify a third meter.

### 7.3 The enterprise floor stays negotiated, and becomes recorded

§4.2 said "negotiated", which in code meant absent — and an absent allowance is
indistinguishable from an unlimited one. A published floor would be more honest
but it is a commercial number, not an architectural one.

The answer is to fix the half that is architectural: an enterprise allowance is a
**required, stored value** on the subscription's plan row, and the meter refuses
to treat a missing one as unlimited. It falls back to the `scale` allowance and
logs, so a mis-provisioned enterprise org under-bills by a bounded amount instead
of running free. "Negotiated" now means "recorded", not "unknown".

**Revisit if** a published enterprise floor is set; only the constant moves.

### 7.4 Retention beyond twelve months is opt-in

Silently accruing storage charges on evidence a customer forgot they were keeping
is the precise surprise this design exists to avoid. Extended retention is
**off by default**: past twelve months, evidence ages out under the organisation's
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
in which the platform bills nothing at all, and that is worse than either end
state.

---

## 8. Traceability

| Decision | Implementation |
|---|---|
| §3.1 top-level only | `packages/oxagen/src/kernel.ts` — `_governedActionScope` AsyncLocalStorage |
| §3.2 exclusions | same file — `noBillingGate`, denial (recorder is past the throw), failed handler, invalid output |
| §3.3 attribution | `GovernedActionRecord` |
| §4.1 bands | `packages/billing/src/action-metering.ts` — `ACTION_RATE_BANDS` |
| §4.2 allowances | same — `TIER_ACTION_ALLOWANCES` |
| §4.3 retention | same — `RETENTION_USD_PER_GB_MONTH`, `CREDIT_REASONS.CONSUME_RETENTION` |
| §4.4 reported at zero | `packages/ai/src/*` charge sites, gated on `fundedBy === "platform"` (ADR-053 §3) |
| §7.2 multi-unit | contract `meter` block, read in the kernel from validated output |
| §7.5 shadow | `OXAGEN_ACTION_METER_MODE` |
