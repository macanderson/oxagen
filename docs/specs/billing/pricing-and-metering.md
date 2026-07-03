# Billing: Pricing, Credits & the Usage Meter

**Status:** active · **Owner:** Mac Anderson · **Last sync:** 2026-05-31 (Stripe **test** mode)

This document describes how Oxagen prices its products, how the usage **gate**
charges customers for what providers (Anthropic, OpenAI) bill us, and how a
single target-margin knob drives every Stripe price. For the day-to-day "how do
I change a price / re-sync Stripe" runbook, see
[`docs/ops/stripe-product-sync-sop.md`](../../ops/stripe-product-sync-sop.md).

---

## 1. The one-paragraph model

Customers buy **credits** (1 credit = **$0.01**, locked — credits are the
customer's currency). They buy them two ways: a **subscription** (recurring fee
that grants a discounted monthly allotment — the incentive to subscribe) or a
one-time **credit pack** (pay-as-you-go, at/near face value). Every LLM call
flows through a **gate** that meters what the provider charged us and **debits
credits marked up to our target margin**. Because the credit's sale price is
fixed at $0.01, **margin is realised at the meter, not on the sticker price** —
the markup is the dial. The markup is *solved* so the volume-weighted **blended
margin across all products = the target** (default **65%**).

---

## 2. Why margin lives in the meter (not the price)

Profit per credit = `1 − (provider cost per credit) / (sale price per credit)`.

The sale price per credit is pinned at $0.01 by business rule, so the only lever
left is the **provider cost per credit**, which the meter sets via its markup:

```
creditsDebited      = ceil( providerCostUsd × markup / creditValueUsd )
⟹ providerCostPerCredit = creditValueUsd / markup
⟹ margin_on_face_value  = 1 − 1/markup
```

A naïve single-product markup would be `1/(1−m)` (≈2.857× at 65%). But
subscriptions sell credits **below** face value (the discount incentive), which
drags their margin under target. So we **solve** the markup over the whole
product mix instead — see §4.

> **Consequence (important):** changing the target margin moves the **meter
> markup** and the **realised margins**, *not* the dollar sticker prices. The
> $/credit a customer pays is a stable anchor; how fast a call burns credits is
> the margin control. This is intentional, not a limitation. The advertised
> dollar prices change only when you change a plan's **allotment** or
> **discount** (the incentive design) — see the SOP.

---

## 3. The cost meter (provider rate card)

The meter's inputs are exactly what providers invoice us on: **tokens in / out
(and cached-input) by model**. The rate card lives in
[`packages/billing/src/pricing.ts`](../../../packages/billing/src/pricing.ts)
(`PROVIDER_RATE_CARD`) as USD per 1,000,000 tokens. Keep it in sync with your
real provider invoices — everything downstream derives from it.

| Model | $/1M in | $/1M out | $/1M cached-in | Provider |
|---|---|---|---|---|
| claude-opus-4-8 | 15.00 | 75.00 | 1.50 | anthropic |
| claude-sonnet-5 (default) | 3.00 | 15.00 | 0.30 | anthropic |
| claude-haiku-4-5 | 1.00 | 5.00 | 0.10 | anthropic |
| gpt-4o | 2.50 | 10.00 | 1.25 | openai |
| gpt-4o-mini | 0.15 | 0.60 | 0.075 | openai |
| text-embedding-3-small | 0.02 | — | 0.02 | openai |

A versioned/date-stamped model id (e.g. `claude-sonnet-5-20260101`) resolves
to the **longest matching prefix**; an unknown id falls back to Sonnet so a
missing model never silently zero-charges (`resolveRate`).

`providerCostUsd()` splits cached-input from billable input and prices each
bucket at its rate. Example — a Sonnet call with 10k input / 2k output:
`10000·$3/1M + 2000·$15/1M = $0.06` → at markup 3.319 → `ceil(0.06×3.319/0.01) =
20 credits` debited.

---

## 4. The blended-margin solve

```
margin_i  = 1 − creditsPerCent_i / markup        # creditsPerCent = credits ÷ price_in_cents
blended   = Σ wᵢ · margin_i                        # wᵢ = expected revenue mix
set blended = m  ⟹  markup = Σ (wᵢ · creditsPerCent_i) / (1 − m)
```

`creditsPerCent` is "how many credits a cent buys": face value = 1.0,
subscriptions/bonus packs > 1.0 (more generous → lower margin). The solve and
the full derivation are pure functions (`solveMeterMarkup`, `derivePricing`) and
are unit-tested to satisfy `derivePricing(m).blendedMargin === m` for every m.

### Current model @ target 65%

```
Meter markup: 3.3190×   (set OXAGEN_METER_MARKUP=3.3190, or leave unset to derive)

Product               Kind          Price      Credits   cr/¢   Margin
Pro                   subscription  $20.00/mo     2,400   1.20   63.8%
Scale                 subscription  $99.00/mo    13,200   1.33   59.8%
Starter Credit Pack   credit_pack   $10.00        1,000   1.00   69.9%
Power Credit Pack     credit_pack   $50.00        5,250   1.05   68.4%
Scale Credit Pack     credit_pack   $200.00      22,000   1.10   66.9%
                                            Blended margin →  65.0%
```

Packs run above target; discounted subscriptions below; the blend is exactly the
target. (Annual subscription prices are 10× monthly = **2 months free**, which
trims the annual cohort's margin a few points below the monthly figure above.)

Revenue-mix weights `wᵢ` are an explicit modelling assumption (currently Pro
0.35 / Scale 0.20 / packs 0.45). They affect only the *solved markup*; revise
them in `pricing.ts` as real usage data arrives.

---

## 5. The gate (where credits are charged)

The gate is [`packages/ai/src/stream.ts`](../../../packages/ai/src/stream.ts)
`streamAgentReply` — every chat/agent surface (app + api) streams through it, so
charging there means **solve once, no drift across surfaces**. In `onFinish`:

1. `providerCostUsdMicros(usage)` prices the call → written to
   `token_usage.cost_usd_micros` in ClickHouse (previously hard-coded to 0 — a
   bug this work fixed).
2. `chargeUsageCredits({ orgId, model, inputTokens, outputTokens, referenceId })`
   debits credits via the ledger (`grantCredits`, reason
   `consume_token_overage`).

Both steps are **best-effort** — a metering or ClickHouse failure must never
fail the user's turn.

### Safety: no overdraft

`credit_balances` has a DB CHECK `balance_cents >= 0`. `chargeUsageCredits`
**clamps** the debit to the available balance and reports a `shortfallCredits`
when the org outruns its credits mid-turn. A zero-cost call inserts **no** ledger
row (the ledger CHECK forbids a zero delta). The real admission control —
refusing a turn when the balance is empty — is the caller's pre-turn guard,
`hasCreditBalance(orgId)`.

Embeddings ([`embed.ts`](../../../packages/ai/src/embed.ts)) are metered for
cost the same way (input-only); they are infrastructure and are not separately
credit-charged today.

---

## 6. The grant side (where credits are deposited)

The other half of the loop lives in
[`packages/billing/src/grants.ts`](../../../packages/billing/src/grants.ts),
wired into the Stripe webhook dispatch:

- **`invoice.paid`** (billing_reason `subscription_create` | `subscription_cycle`)
  → grants the plan's `includedCreditCents` (reason `grant_plan_renewal`). One
  grant per paid invoice — first period and every renewal, never an upgrade.
- **`checkout.session.completed`** (mode `payment`) → grants the pack's credits,
  read from the price/product `credits` metadata the sync script writes (reason
  `grant_credit_pack`).

Idempotency comes from `processStripeEvent`, which de-dups on
`stripe_event_id`, so a retried webhook grants exactly once.

---

## 7. Products & the source of truth

The **single source of truth** is `SUBSCRIPTION_PLANS` + `CREDIT_PACKS` +
`PROVIDER_RATE_CARD` in `pricing.ts`. Everything else is derived:

- **Stripe** products/prices — created by `pnpm billing:stripe-sync` (§ SOP).
- **`billing.plans`** rows — upserted by the same script (subscriptions only;
  packs are Stripe-only + config, since `plans` is recurring-shaped).

Naming convention (per the request):
- Product **display name** carries **no** version suffix: `Pro`, `Scale`,
  `Starter Credit Pack`.
- The **identifier** carries the v2 suffix everywhere it's a key:
  `plans.slug` = `pro-v2`, Stripe `metadata.oxagen_slug` = `pro-v2`,
  price `lookup_key` = `pro_v2_month`. `metadata.oxagen_version = "v2"`.

`tier` stays inside the existing `billing.plans` CHECK (`free|pro|enterprise`):
Pro→`pro`, Scale→`enterprise`. Product identity is the slug, so no schema
migration was needed.

---

## 8. Runtime configuration

| Env var | Meaning | Default |
|---|---|---|
| `OXAGEN_TARGET_MARGIN` | Target blended gross margin (0,1). Drives the solve. | `0.65` (DEFAULT_TARGET_MARGIN) |
| `OXAGEN_METER_MARKUP` | Optional hard pin of the solved markup so runtime never recomputes. | unset → derived from target + mix |

Both are registered in `packages/config/src/env.ts` and the Vercel env catalog
(`tools/env-manager/src/catalog.ts`, `OXAGEN_TARGET_MARGIN` static `0.65` across
envs). Leaving `OXAGEN_METER_MARKUP` unset keeps a single source of truth (the
code); pinning it decouples runtime from a config edit until the next sync.

---

## 9. Bugs fixed by this work

- `token_usage.cost_usd_micros` was hard-coded to `0` in the gate and embeddings
  → now priced via the rate card.
- `providerFromModelId` returned `""` for the bare model ids the gate actually
  uses (`claude-sonnet-5`) → now infers the provider from the family.
- Credits were **never** charged on LLM calls and **never** granted on
  purchase/renewal → both halves of the loop are now wired.
- `billing.plans` seed carried placeholder Stripe ids and unrealistic
  `includedCreditCents` (e.g. 500,000) → real synced values.

---

## 10. Files

| Concern | File |
|---|---|
| Pricing model + rate card + solve | `packages/billing/src/pricing.ts` |
| Cost meter / gate charge | `packages/billing/src/metering.ts` |
| Credit grants (purchase/renewal) | `packages/billing/src/grants.ts` |
| Gate wiring (LLM) | `packages/ai/src/stream.ts` |
| Gate wiring (embeddings cost) | `packages/ai/src/embed.ts` |
| Webhook dispatch | `packages/billing/src/webhooks.ts` |
| Sync script | `tools/scripts/stripe-sync.ts` |
| Tests | `packages/billing/src/__tests__/{pricing,metering}.test.ts`, `packages/ai/src/stream.test.ts` |
