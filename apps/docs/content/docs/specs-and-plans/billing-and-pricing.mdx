---
title: "Billing, Pricing & Metering"
description: "Archived spec & plan — status: partially shipped (audited 2026-07-03)."
---

> **Status: Partially shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The core billing and metering infrastructure is implemented (database schema, credit grants, pre-turn admission gate, pricing model, Stripe sync), but secondary features are missing: tool call metering (web_search, code_sandbox flat fees), real-time credit chip stream events (CreditDeltaEvent), and a critical rate card fix for Opus pricing. The spec's 5-step build sequence has 3–4 steps complete, but Step 3 (tool metering) and UI polish remain unshipped.

**Implementation evidence**

- packages/database/atlas/migrations/20260611233016_initial_schema.sql — billing schema with credit_ledger, credit_balances, credit_lots tables created
- packages/billing/src/grants.ts — grantFreeCredits(), grantPlanCreditsForInvoicePaid(), grantCreditPackForCheckout() all implemented with reference_id resolution
- packages/billing/src/metering.ts — assertCanStartTurn() admission gate, chargeUsageCredits() metering, InsufficientCreditsError defined
- packages/billing/src/pricing.ts — PROVIDER_RATE_CARD, resolveRate(), solveMeterMarkup(), derivePricing() all implemented
- packages/billing/src/bootstrap.ts — billing admission gate wired into kernel via setBillingAdmissionGate()
- apps/api/src/bootstrap.ts — bootstrapBillingRuntime() called on startup
- apps/app/instrumentation.ts — bootstrapBillingRuntime() called on startup
- tools/scripts/stripe-sync.ts — billing:stripe-sync command for Stripe product sync
- packages/oxagen/src/contracts/billing.* — billing.credits.purchase, billing.subscription.read, billing.subscription.upgrade.start contracts defined
- apps/app/src/components/billing/ — credit-balance.tsx, buy-credits.tsx UI components exist

**Known gaps at time of archive**

- Step 1 rate card fix: claude-opus-4-8/claude-opus-4 still priced at $15/$75 (legacy) instead of $5/$25 (Opus 4.7); spec explicitly calls this a blocking 3x overcharging bug
- Step 3 tool call metering: web_search and code_sandbox:execute are not charged flat fees (1–2 credits); spec says 'currently absent' and remains absent
- CreditDeltaEvent stream event type in apps/app/src/components/chat/stream-event-types.ts (proposed in spec §8)
- CreditBalanceContext React context in app (proposed in spec §8)
- Real-time credit chip updates via stream (spec A1 design: emit credit-delta event post-onFinish)

**Source documents** (archived verbatim below)

- `docs/specs/billing/hybrid-billing-and-pricing.md`
- `docs/specs/billing/pricing-and-metering.md`

## Document — `hybrid-billing-and-pricing.md`

## Oxagen Hybrid Billing — Authoritative Reference

> Status: authoritative as of 2026-05-31.
> Supersedes `pricing-and-metering.md`.
> Owner: Mac Anderson (mac@oxagen.ai)

---

### Table of Contents

1. [Credit Model](#1-credit-model)
2. [Subscription Tiers](#2-subscription-tiers)
3. [PAYG Credit Packs](#3-payg-credit-packs)
4. [Full Cost Table](#4-full-cost-table)
5. [Metering Design](#5-metering-design)
6. [Credit Ledger Design](#6-credit-ledger-design)
7. [Stripe Products / Prices Spec](#7-stripe-products--prices-spec)
8. [Real-Time Credit Chip Design](#8-real-time-credit-chip-design)
9. [Billing Page Design](#9-billing-page-design)
10. [Policy Application Plan](#10-policy-application-plan)
11. [Portability / Vercel-Ejection](#11-portability--vercel-ejection)
12. [Infrastructure Decisions](#12-infrastructure-decisions)
13. [Implementation Build Sequence](#13-implementation-build-sequence)

---

### 1. Credit Model

**Core rule: 1 credit = $0.01 USD. Locked. Do not change without a full pricing audit.**

Credits are the customer-facing currency. Every billable platform action debits credits from an org's balance. Credits are granted by:

- Subscription renewals (monthly or annual) — `grantPlanCreditsForInvoicePaid()`
- Credit pack purchases — `grantCreditPackForCheckout()`
- Signup bonus — `grantCredits(..., reason: "grant_signup")` for 500 credits on org creation (free trial runway)

Credits never expire within a subscription period. Unused monthly credits do not roll over when a new period's grant fires.

#### Margin mechanics

Target gross margin: **65%**.

Markup multiplier applied to every provider cost:

```
markup = 1 / (1 - 0.65) = 1 / 0.35 = 2.857142857…
```

Per-turn credit charge formula:

```
creditCharge = ceil(providerCostUsd * markup / CREDIT_VALUE_USD)
```

`ceil()` ensures realized margin is always ≥ 65%. For most token counts this is 65.0-66.x%.

**Rate card update required:** The production `PROVIDER_RATE_CARD` in `packages/billing/src/pricing.ts` currently contains `claude-opus-4-8` and `claude-opus-4` at $15.00/$75.00 (legacy Opus 4.1 pricing). Claude Opus 4.7 (the current production model as of May 2026) is $5.00/$25.00 per 1M tokens. The legacy entries cause 3x overcharging for any call routed to a `claude-opus-4*` prefix. Fix in Step 1 of the build sequence.

#### Subscription margin proof

Provider cost to back 1 credit at 65% margin: `$0.01 * (1 - 0.65) = $0.0035`.

| Tier | Monthly price | Included credits | Provider cost | Gross margin |
|---|---|---|---|---|
| Starter | $50 | 5,000 | 5,000 × $0.0035 = $17.50 | ($50 - $17.50) / $50 = **65.0%** |
| Growth | $200 | 20,000 | 20,000 × $0.0035 = $70.00 | ($200 - $70) / $200 = **65.0%** |
| Scale | $600 | 60,000 | 60,000 × $0.0035 = $210.00 | ($600 - $210) / $600 = **65.0%** |

All three tiers hit exactly 65% because `includedCredits = monthlyPriceUsd / $0.01 × (1 - 0.65)` is applied consistently.

**Important note on markup pinning:** The v3 product mix includes volume-bonus credit packs (credits > face value). With the recommended product-mix weights, `derivePricing()` returns a blended markup of approximately **2.9086**, not 2.857. When running `pnpm billing:stripe-sync --apply`, pin the solved value: `OXAGEN_METER_MARKUP=2.9086`. Do not hardcode 2.857 in env — it will produce an auditable 0.18% discrepancy against the solve.

---

### 2. Subscription Tiers

All prices in USD. Annual price = 10× monthly (two months free).

#### Starter — $50/month | $500/year

- **5,000 credits/month** included ($50 face value)
- All tools and capabilities
- Up to 10 active agents
- Claude Haiku + Sonnet access
- Email support
- 3 seats
- Pay-as-you-go credits when allowance runs out

#### Growth — $200/month | $2,000/year

- **20,000 credits/month** included ($200 face value)
- All tools and capabilities
- Unlimited active agents
- Claude Haiku + Sonnet + Opus access
- Priority email support
- 10 seats
- Pay-as-you-go credits when allowance runs out
- Usage analytics dashboard
- Workspace-level credit budgets

#### Scale — $600/month | $6,000/year

- **60,000 credits/month** included ($600 face value)
- All tools and capabilities
- Unlimited active agents
- All models including Claude Opus 4.7
- Dedicated Slack support channel
- 25 seats + SSO
- Pay-as-you-go credits when allowance runs out
- Advanced usage analytics and cost attribution
- Per-workspace and per-agent credit budgets
- SLA: 99.9% uptime commitment
- Custom rate negotiation available

---

### 3. PAYG Credit Packs

One-time purchases. Credits are granted immediately on `checkout.session.completed` webhook.

| Pack | Price | Credits | Bonus | Effective $/credit | Blended margin |
|---|---|---|---|---|---|
| Starter Pack | $10 | 1,000 | 0 (0%) | $0.01000 | 65.0% |
| Power Pack | $50 | 5,250 | +250 (5%) | $0.00952 | ~63.2% |
| Scale Pack | $200 | 22,000 | +2,000 (10%) | $0.00909 | ~61.8% |
| Enterprise Pack | $500 | 57,500 | +7,500 (15%) | $0.00870 | ~60.0% |

Volume bonuses intentionally trim pack margin slightly as a volume incentive. The subscription product mix compensates in the blended solve.

**No auto-top-up in v1.** Manual pack purchase only. Auto-top-up (off-session Stripe payment intent) is a follow-on ticket after Stripe Customer Portal integration is confirmed.

---

### 4. Full Cost Table

Source: Anthropic platform.claude.com/docs/en/about-claude/pricing (verified May 2026) and OpenAI openai.com/pricing (verified May 2026).

Markup = 2.857142857. Formula: `creditCharge = ceil(providerCostUsd * 2.857142857 / 0.01)`.

#### LLM Token Costs (per 1M tokens)

| Model / Direction | Provider cost / 1M | Markup | Credit charge / 1M | Revenue / 1M | Realized margin |
|---|---|---|---|---|---|
| Claude Opus 4.7 — input | $5.00 | ×2.857 | **1,429 cr** | $14.29 | 65.0% |
| Claude Opus 4.7 — output | $25.00 | ×2.857 | **7,143 cr** | $71.43 | 65.0% |
| Claude Opus 4.7 — cached input | $0.50 | ×2.857 | **143 cr** | $1.43 | 65.0% |
| Claude Sonnet 4.6 — input | $3.00 | ×2.857 | **858 cr** | $8.58 | 65.0% |
| Claude Sonnet 4.6 — output | $15.00 | ×2.857 | **4,286 cr** | $42.86 | 65.0% |
| Claude Sonnet 4.6 — cached input | $0.30 | ×2.857 | **86 cr** | $0.86 | 65.1% |
| Claude Haiku 4.5 — input | $1.00 | ×2.857 | **286 cr** | $2.86 | 65.0% |
| Claude Haiku 4.5 — output | $5.00 | ×2.857 | **1,429 cr** | $14.29 | 65.0% |
| Claude Haiku 4.5 — cached input | $0.10 | ×2.857 | **29 cr** | $0.29 | 65.5% |

#### Embedding Costs (per 1M tokens)

| Model | Provider cost / 1M | Credit charge / 1M | Revenue / 1M | Realized margin |
|---|---|---|---|---|
| text-embedding-3-small | $0.02 | **6 cr** | $0.06 | 66.7% |
| text-embedding-3-large | $0.13 | **38 cr** | $0.38 | 65.8% |

#### Tool Call Flat Fees

| Tool | Provider cost / call | Credit charge | Revenue | Realized margin |
|---|---|---|---|---|
| web_search | $0.003 | **1 cr** | $0.01 | 70.0% |
| code_sandbox:execute | $0.005 | **2 cr** | $0.02 | 75.0% |

#### Worked Example — Typical Agent Turn (Sonnet 4.6)

```
Input tokens:  2,000
Output tokens:   500

Provider cost:
  input  = 2,000 / 1,000,000 × $3.00  = $0.0060
  output =   500 / 1,000,000 × $15.00 = $0.0075
  total                                = $0.0135

Credits charged:
  input  = ceil(2,000 / 1,000,000 × 858)  = ceil(1.716)  = 2
  output = ceil(500 / 1,000,000 × 4,286)  = ceil(2.143)  = 3
  total                                                    = 5 credits ($0.05 revenue)

Realized margin = ($0.05 - $0.0135) / $0.05 = 73.0%
```

(Higher than 65% because small token counts round up more aggressively. The margin guarantee is that the blend across all turns is ≥ 65%, not that each individual turn is exactly 65%.)

---

### 5. Metering Design

#### LLM Gate (primary path)

Location: `packages/ai/src/stream.ts` — `onFinish` callback of `streamAgentReply`.

```
onFinish({ usage }) {
  await chargeUsageCredits(orgId, usage.inputTokens, usage.outputTokens, modelId, turnId);
}
```

`chargeUsageCredits` in `packages/billing/src/metering.ts`:
1. Resolves model rate from `PROVIDER_RATE_CARD` (longest-prefix match via `resolveRate()`).
2. Computes `providerCostUsd = (inputTokens / 1e6 × inputPer1M) + (outputTokens / 1e6 × outputPer1M)`.
3. Computes `creditCharge = ceil(providerCostUsd × markup / CREDIT_VALUE_USD)`.
4. Calls `grantCredits(orgId, -creditCharge, { reason: "consume_llm", referenceId: turnId })`.

**Pre-turn admission gate (currently missing — Step 4 of build sequence):**

Before `streamAgentReply` is called, the chat route must call `hasCreditBalance(orgId)`. If false, return HTTP 402 with body `{ error: "insufficient_credits" }`. This prevents the free-ride window where a zero-balance org gets a full model call.

```typescript
// apps/app/src/app/api/chat/stream/route.ts — required addition
const hasCredits = await hasCreditBalance(orgId);
if (!hasCredits) {
  return new Response(JSON.stringify({ error: "insufficient_credits" }), {
    status: 402,
    headers: { "Content-Type": "application/json" },
  });
}
```

**Double-spend fix (Step 4):**

The current `chargeUsageCredits` reads balance outside the transaction, then calls `grantCredits` in a separate transaction. Two concurrent streams can both read the same stale balance. Fix: execute `SELECT ... FOR UPDATE` on `credit_balances` inside the `grantCredits` transaction to serialize the read-modify-write. Alternatively, catch Postgres error code `23514` (CHECK violation on `balance_cents >= 0`) and return `creditsCharged: 0n` rather than rethrowing.

#### Tool Call Gate (flat fees)

Location: `packages/ai/src/materialize-tools.ts` — `execute` closure for each tool.

```typescript
// Inside the execute closure for web_search:
await grantCredits(orgId, -1, { reason: "consume_tool_call", referenceId: toolCallId });

// Inside the execute closure for code sandbox:
await grantCredits(orgId, -2, { reason: "consume_tool_call", referenceId: toolCallId });
```

This is currently absent (Step 3 of build sequence). Any tool call bypassing the LLM gate is currently uncharged.

#### Signup Grant

Location: `apps/api/src/routes/organizations.ts` (or equivalent org creation path).

```typescript
// After org record is created:
await grantCredits(orgId, 500, { reason: "grant_signup" });
```

Currently absent (Step 2 of build sequence). New orgs start with zero credits.

---

### 6. Credit Ledger Design

#### Tables (already exist in `packages/database/src/schema/billing.ts`)

```sql
-- Append-only audit log. One row per credit transaction.
-- Schema policy: only id, created_at, created_by_user_id — no updated_*, no deleted_at.
CREATE TABLE billing.credit_ledger (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  delta_credits     BIGINT NOT NULL,          -- negative for debits, positive for grants
  reason            TEXT NOT NULL,            -- "grant_signup" | "grant_plan" | "consume_llm" | "consume_tool_call" | "grant_pack"
  reference_type    TEXT,                     -- "stripe_invoice" | "stripe_checkout" | "agent_turn" | null
  reference_id      UUID,                     -- internal UUID (not Stripe string IDs — see note)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_user_id UUID                     -- null for system grants
);

-- Mutable balance cache. One row per org. Updated atomically with ledger insert.
CREATE TABLE billing.credit_balances (
  org_id          UUID PRIMARY KEY REFERENCES organizations(id),
  balance_cents   BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Note on `reference_id`:** The column is `UUID` type. Stripe invoice IDs (`in_...` strings) are not valid UUIDs and cannot be stored here. `grantPlanCreditsForInvoicePaid` in `grants.ts` currently omits `referenceId` entirely (the row has `reference_id: null`). Fix: look up the internal `billing.invoices` row by Stripe invoice ID and store its UUID in `reference_id`. This enables ledger-to-invoice reconciliation. See Step 5 of build sequence.

#### Atomic write pattern

Every `grantCredits` call executes one Postgres transaction:

```sql
BEGIN;
INSERT INTO billing.credit_ledger (org_id, delta_credits, reason, reference_id)
VALUES ($orgId, $delta, $reason, $referenceId);

INSERT INTO billing.credit_balances (org_id, balance_cents)
VALUES ($orgId, $delta)
ON CONFLICT (org_id) DO UPDATE
  SET balance_cents = billing.credit_balances.balance_cents + EXCLUDED.balance_cents,
      updated_at    = now();
COMMIT;
```

The `CHECK (balance_cents >= 0)` on `credit_balances` enforces no-overdraft at the database level. When the CHECK fires, the transaction rolls back — no ledger row is written.

#### Balance read

`hasCreditBalance(orgId)` reads `credit_balances.balance_cents > 0`. Must use `SELECT ... FOR UPDATE` inside a transaction when the result is used as an admission gate to prevent the double-spend race described in §5.

---

### 7. Stripe Products / Prices Spec

Machine-readable spec: `docs/architecture/billing/stripe-products.json`.

To create in production:

```bash
pnpm billing:stripe-sync --apply
```

#### Subscription products (3 tiers × 2 intervals = 6 prices)

| Product | Price nickname | Amount | Interval |
|---|---|---|---|
| Oxagen Starter | Starter Monthly | $50.00 | month |
| Oxagen Starter | Starter Annual | $500.00 | year |
| Oxagen Growth | Growth Monthly | $200.00 | month |
| Oxagen Growth | Growth Annual | $2,000.00 | year |
| Oxagen Scale | Scale Monthly | $600.00 | month |
| Oxagen Scale | Scale Annual | $6,000.00 | year |

Annual prices grant credits equivalent to 12× the monthly included amount (e.g., Starter annual = 60,000 credits for the year).

#### Credit pack products (4 one-time prices)

| Product | Price nickname | Amount | Credits |
|---|---|---|---|
| Oxagen Credits — Starter Pack | Starter Pack | $10.00 | 1,000 |
| Oxagen Credits — Power Pack | Power Pack | $50.00 | 5,250 |
| Oxagen Credits — Scale Pack | Scale Pack | $200.00 | 22,000 |
| Oxagen Credits — Enterprise Pack | Enterprise Pack | $500.00 | 57,500 |

All prices use `currency: "usd"`. All metadata fields (slug, credits, billing_cycle) are set on both the Product object and the Price object so they are accessible without a product lookup in webhook handlers.

#### Webhook events to handle

- `invoice.payment_succeeded` → `grantPlanCreditsForInvoicePaid()`
- `checkout.session.completed` (mode: `payment`) → `grantCreditPackForCheckout()`
- `checkout.session.completed` (mode: `subscription`) → write `billing.subscriptions` row

#### Idempotency

`processStripeEvent()` stores `stripe_event_id` and uses `ON CONFLICT DO NOTHING`. All webhook handlers are safe to retry.

---

### 8. Real-Time Credit Chip Design

#### Selected option: A1 — ride existing SSE pipe

No new infrastructure. The chip updates at stream end (when `onFinish` fires) — "as fresh as the last prompt."

#### Data flow

```
1. User sends message → POST /api/chat/stream
2. Route calls hasCreditBalance (gate) → stream begins
3. Model streams tokens → client renders
4. onFinish fires → chargeUsageCredits() → grantCredits() commits
5. Route emits credit-delta StreamEvent: { type: "credit-delta", balance: N, delta: -M }
6. ChatShellClient reads event → CreditBalanceContext.setBalance(N)
7. Credit chip re-renders with animated transition
```

#### New types required

Add to `packages/ai/src/stream-event-types.ts`:

```typescript
export interface CreditDeltaEvent {
  type: "credit-delta";
  /** New org balance in credits after this turn's charge. */
  balance: number;
  /** Credits debited this turn (negative integer). */
  delta: number;
}

// Add CreditDeltaEvent to StreamEvent union:
export type StreamEvent = ... | CreditDeltaEvent;
```

#### New context required

Create `apps/app/src/contexts/CreditBalanceContext.tsx`:

```typescript
"use client";
import { createContext, useContext, useState, ReactNode } from "react";

interface CreditBalanceContextValue {
  balance: number | null;
  setBalance: (balance: number) => void;
}

const CreditBalanceContext = createContext<CreditBalanceContextValue>({
  balance: null,
  setBalance: () => {},
});

export function CreditBalanceProvider({ children, initialBalance }: {
  children: ReactNode;
  initialBalance: number | null;
}) {
  const [balance, setBalance] = useState<number | null>(initialBalance);
  return (
    <CreditBalanceContext.Provider value={{ balance, setBalance }}>
      {children}
    </CreditBalanceContext.Provider>
  );
}

export function useCreditBalance() {
  return useContext(CreditBalanceContext);
}
```

#### Chat shell client changes

In `ChatShellClient`, add to the stream event handler:

```typescript
case "credit-delta":
  creditBalanceCtx.setBalance(event.balance);
  break;
```

#### Credit chip component

`apps/app/src/components/CreditChip.tsx` — reads `useCreditBalance()`, displays formatted credits with a subtle animate-down transition when `delta` is negative.

#### Future: cross-surface balance (A3)

When live balance is needed on non-chat pages (agents page, execution dashboard), add Redis pub/sub:

1. After `grantCredits` commits, call `publishCreditBalance(orgId, newBalance)`.
2. `GET /api/billing/credits/stream` subscribes via `ioredis` (Node runtime, not serverless) and streams `text/event-stream`.
3. Client `EventSource` on that URL, updates `CreditBalanceContext`.

The `REDIS_URL` env var is already in GSM. `publishCreditBalance` is a no-op when `REDIS_URL` is absent. This ensures A1 ships first, A3 can be layered on without any breaking changes.

---

### 9. Billing Page Design

Location: `apps/app/src/app/[orgSlug]/settings/billing/page.tsx`

#### Sections

**1. Current plan card**
- Tier name, monthly/annual badge
- Current period included credits + used/remaining progress bar
- Next renewal date
- "Upgrade" / "Manage" CTA → Stripe Customer Portal

**2. Credit balance chip**
- Large display: `N credits remaining`
- USD equivalent: `($N.NN)`
- Animated on page load; updated in real-time via `CreditBalanceContext`
- Low-balance warning at ≤ 500 credits (Starter) / ≤ 2,000 credits (Growth/Scale)

**3. Buy credits section**
- Four pack cards (Starter, Power, Scale, Enterprise)
- Each shows: price, credit count, bonus badge (if applicable), "Buy" button
- "Buy" → `createCreditPackCheckoutSession(slug)` → redirect to Stripe Checkout
- Return URL: `/[orgSlug]/settings/billing?purchase=success`

**4. Usage chart**
- 30-day rolling view of credit consumption by day
- Breakdown by category: LLM input / LLM output / embeddings / tool calls
- Data from ClickHouse (append-only usage events) via `/api/billing/usage`

**5. Ledger (recent transactions)**
- Table: date, description, delta (color-coded), running balance
- Paginated, 20 rows default
- Data from `billing.credit_ledger` via `/api/billing/ledger`

**6. Auto-top-up (v2, not in initial build)**
- Toggle: enable auto-top-up
- When enabled: select pack + threshold (e.g. top up with Power Pack when balance drops below 1,000)
- Requires `billing.auto_top_up_configs` table + off-session Stripe payment intent flow

---

### 10. Policy Application Plan

This section maps each policy in the `oxagen-engineering-policy` skill (`.agents/skills/oxagen-engineering-policy/policies/`) to the billing codebase and specifies what must be enforced.

#### Policy 0 (Prime Directives) — applies to ALL billing files

**What to enforce:**

- `billing.credit_ledger` is append-only: no `updated_at`, no `deleted_at`. Schema is compliant. Do not add mutable columns.
- `billing.credit_balances` is a mutable entity: must have `updated_at` (already present). No `deleted_at` (balance rows are never deleted — they go to 0).
- No `any` type in `cost-table.ts`, `pricing.ts`, `metering.ts`, `credits.ts`, `grants.ts`, `checkout.ts`. Use `unknown` at JSON parse boundaries, then narrow.
- Zero warnings from `tsc --noEmit`. Run in CI.
- All secrets (Stripe keys, REDIS_URL) flow via env vars validated by `packages/config/src/env.ts` with `requireEnv()`. Never hardcoded.
- Structured logging on every `grantCredits` call: `{ orgId, delta, reason, balance_after, duration_ms }`.
- SOC 2: every credit debit has a ledger row. The ledger is the audit trail. No debit without a row.

**Files affected:** every file in `packages/billing/src/`.

#### Policy 1 (Package Versions) — `packages/billing/package.json`

- Exact version pins on `stripe`, `@upstash/redis` (if used), `ioredis` (if used).
- No `^` or `~` ranges.
- Before adding any new billing dep, confirm no existing dep covers the need.

#### Policy 2 (Vendor Lock-In) — `packages/billing/src/client.ts`, `checkout.ts`

- Stripe SDK is already wrapped behind `packages/billing/src/client.ts` (`getStripeClient()`). All Stripe calls must go through this wrapper — never import `stripe` directly from business logic.
- `checkout.ts`, `grants.ts`, `webhooks.ts` all call `getStripeClient()` — compliant.
- If Redis pub/sub is added for A3, wrap the Redis client behind `packages/billing/src/redis-client.ts` — never import `ioredis` directly from domain logic.
- The `cost-table.ts` file has zero external dependencies by design — just math. Keep it that way.

#### Policy 3 (Code Bloat) — all billing files

- `COST_TABLE`, `SUBSCRIPTION_TIERS`, `CREDIT_PACKS` are the definitions. Do not maintain parallel copies in `pricing.ts` after the cost-table migration. Delete the old definitions once the new ones are wired.
- `creditChargeForTokens()` in `cost-table.ts` is the single function for per-token math. `chargeUsageCredits()` in `metering.ts` calls it — no inline duplication.
- The `LEGACY_SUBSCRIPTION_PLANS` const in `pricing.ts` must have an explicit removal date in a comment. It is kept only long enough for the Stripe sync script to archive the old products. Remove it after sync confirms the v3 products are live.

#### Policy 3.5 (Code Simplification) — `metering.ts`, `grants.ts`

- No plugin system, no event bus, no extension points. `grantCredits` is a direct Postgres function call. Keep it that way.
- Auto-top-up logic (when added) goes in a new `auto-top-up.ts` file. Do not extend `credits.ts` speculatively.

#### Policy 4 (Schema Bloat) — `packages/database/src/schema/billing.ts`

- Do not add nullable columns without a documented performance or migration reason.
- `billing.plans` `tier` CHECK: current values are `'free','pro','enterprise'`. The v3 tier slug mapping (Starter→free, Growth→pro, Scale→enterprise) fits without a migration. If display names are added as a column later, use an enum, not a free-text column.
- `auto_top_up_configs` table (when added): must have `id UUID PK`, `created_at`, `created_by_user_id`, `updated_at`, `updated_by_user_id`. No `deleted_at` (rows are disabled, not deleted — use an `enabled BOOLEAN` column).

#### Policy 5 (Migrations) — any schema change

- One logical change per migration file.
- Add `claude-opus-4-7` to the rate card via a data migration to `billing.plans` if plan metadata is stored in the DB. If it is code-only (pricing.ts), no migration needed.
- If the `tier` CHECK is ever broadened to add `'starter'`, `'growth'`, `'scale'` as distinct values: use expand-then-contract. Phase 1: add new CHECK allowing both old and new values, backfill. Phase 2: remove old values from CHECK.

#### Policy 6 (Testing) — `packages/billing/src/__tests__/`

- Every function in `cost-table.ts` must have a unit test: margin >= 65% for every entry, `creditChargeForTokens` boundary cases (0 tokens = 0 credits, 1 token = 1 credit, 1M tokens = entry.creditCharge credits).
- `grantCredits` must have an integration test against a test Postgres instance: verify ledger row is written + balance is updated atomically, verify CHECK fires and rolls back on overdraft.
- `chargeUsageCredits` must have a test that triggers the `FOR UPDATE` path and confirms no double-spend.
- `hasCreditBalance` must have tests for: zero balance = false, positive balance = true.
- Stripe webhook handler tests must cover idempotency: same event ID processed twice produces one ledger row, not two.

#### Policy 7 (File Organization) — `packages/billing/src/`

File layout for the completed billing package:

```
packages/billing/src/
  cost-table.ts          # COST_TABLE, SUBSCRIPTION_TIERS, CREDIT_PACKS — single source of truth
  pricing.ts             # PROVIDER_RATE_CARD, resolveMeterMarkup() — rate card for metering
  credits.ts             # grantCredits() — the one ledger write function
  metering.ts            # chargeUsageCredits(), hasCreditBalance(), meterCreditsForUsage()
  grants.ts              # grantPlanCreditsForInvoicePaid(), grantCreditPackForCheckout()
  checkout.ts            # createCheckoutSession(), createCreditPackCheckoutSession()
  customers.ts           # Stripe customer record management
  subscriptions.ts       # subscription read/write helpers
  webhooks.ts            # processStripeEvent() + event router
  invoices.ts            # invoice record helpers
  usage.ts               # usage aggregation queries (ClickHouse)
  redis-client.ts        # (add in A3) publishCreditBalance(), Redis wrapper
  index.ts               # public exports
  __tests__/
    cost-table.test.ts
    metering.test.ts
    grants.test.ts
    webhooks.test.ts
```

#### Policy 8 (Documentation) — `packages/billing/README.md`

The README must cover: what the package exports, how to run the billing sync script, how to add a new billable item (update `cost-table.ts`, update `materialize-tools.ts` execute closure, write a test).

---

### 11. Portability / Vercel-Ejection

**Design constraint:** No Vercel-proprietary features are used in the billing system. Every component maps cleanly to a standard AWS equivalent.

#### Component-by-component AWS equivalents

| Billing component | Vercel deployment | AWS equivalent | Effort to migrate |
|---|---|---|---|
| `apps/api` — Stripe webhook route | Vercel serverless function | AWS Lambda + API Gateway (or ECS Fargate) | Trivial: env var swap for function URL |
| `apps/app` — billing page + chat stream route | Vercel serverless (Next.js) | ECS Fargate + ALB, or Lambda Response Streaming | Low: Next.js is portable, no Vercel-specific APIs used |
| PostgreSQL (billing schema) | Neon serverless (current) | AWS RDS PostgreSQL or Aurora PostgreSQL | Low: standard SQL, no Neon-proprietary extensions used |
| ClickHouse (usage events) | ClickHouse Cloud | AWS ClickHouse Cloud (same vendor, AWS-backed region `us-east-2`) | None: same service, different region/endpoint |
| Redis pub/sub (A3, future) | Upstash Valkey REST | ElastiCache Valkey (ioredis client) | Low: swap `@upstash/redis` for `ioredis`, update `REDIS_URL` |
| Stripe SDK | Vercel marketplace app | Direct Stripe integration (env vars already own the keys) | None: Stripe is not a Vercel service |

#### Confirmed: no Vercel-proprietary lock-in

- The chat stream route uses a plain `ReadableStream` with `text/event-stream` headers. This is not Vercel-specific.
- No usage of Vercel Edge Config, Vercel KV, Vercel Blob, or Vercel AI SDK primitives in the billing path.
- The A1 credit chip approach (ride existing SSE pipe) works identically on ECS and Lambda Response Streaming.
- `NextRequest` / `NextResponse` are Next.js APIs, not Vercel APIs. They work on any Next.js host.

#### Migration steps (when needed)

1. Update `DATABASE_URL` to point to RDS/Aurora.
2. Update `REDIS_URL` to point to ElastiCache (swap `@upstash/redis` for `ioredis` in `redis-client.ts`).
3. Update `CLICKHOUSE_URL` to point to ClickHouse Cloud in AWS region.
4. Deploy `apps/api` to Lambda or ECS — no code changes required.
5. Deploy `apps/app` to ECS with Next.js standalone output — no code changes required.

---

### 12. Infrastructure Decisions

#### Decision A — Real-time credit chip transport

**Recommendation: A1 (ride existing SSE pipe). Ship now.**

| Option | How it works | Vercel | AWS | Recommendation |
|---|---|---|---|---|
| **A1: Existing SSE pipe** | Emit `credit-delta` event from chat stream route post-`onFinish`. Chip reads from `CreditBalanceContext`. | Yes — same response stream | Identical | **Recommended. Zero new infra.** |
| A2: Standalone SSE endpoint | `GET /api/billing/credits/stream` polls Postgres per org. Client `EventSource`. | Risky on Hobby (25s max). OK on Pro/Enterprise. | ECS long-lived process | Extra connection per tab. Good for non-chat pages when A3 is too heavy. |
| A3: Redis pub/sub → SSE | After `grantCredits`, `PUBLISH credits:{orgId}`. SSE route subscribes. | Upstash REST client (no persistent TCP). | ElastiCache + ioredis | Max freshness across all surfaces. Use when agents page needs live balance. |

**Portable default:** A1. No Redis required.
**AWS path for A3:** ElastiCache Valkey, ioredis client, long-lived Node process on ECS.

#### Decision B — Auto-top-up payment method

**Recommendation: B3 (manual top-up only) in v1. Add B1 in follow-on.**

| Option | Mechanism | Notes |
|---|---|---|
| **B3: Manual only** | User buys pack via Checkout. No automatic trigger. | **Ship first. Simplest.** |
| B1: Off-session Stripe PaymentIntent | Store `stripe_payment_method_id`. Trigger off-session payment when balance = 0. | Requires `setup_future_usage: "off_session"` in initial checkout. Ship after Customer Portal confirmed. |
| B2: Stripe Billing meter events | Fire `stripe.billing.meterEvents.create()` | Adds Stripe dependency to metering path. Not recommended. |

#### Decision C — Redis / pub-sub client

**Recommendation: C3 (skip Redis in v1). Wire C2 when A3 is needed.**

| Option | Client | Vercel | AWS |
|---|---|---|---|
| C1: `@upstash/redis` REST | REST-over-HTTPS, no persistent TCP | Works in serverless | Not ElastiCache-compatible without Upstash |
| **C2: `ioredis`** | Standard Redis client, connection pool | Requires Node runtime, 60s max on Vercel functions | **ElastiCache drop-in. Recommended for AWS.** |
| **C3: No Redis in v1** | N/A | N/A | **Ship A1 first. Add C2 when A3 needed.** |

`REDIS_URL` is kept in env schema (optional). `publishCreditBalance` is a no-op when absent. This ensures A1 ships with zero Redis dependency and A3 can be layered on later.

---

### 13. Implementation Build Sequence

Ordered by dependency. Steps 1-4 are independent and can be built in parallel by separate agents. Steps 5-8 require 1-4. Steps 9-12 are UI, require 5-8.

#### Step 1 — Rate card fix + v3 plan definitions

**Why first:** All downstream metering, Stripe sync, and billing page work depends on correct rates and plan slugs.

**Files to create/modify:**

| File | Change |
|---|---|
| `packages/billing/src/pricing.ts` | Add `"claude-opus-4-7"` entry at $5.00/$25.00/$0.50. Move above `"claude-opus-4-8"` for prefix resolution. Move old Opus entries to `LEGACY_RATE_CARD`. Update `SUBSCRIPTION_PLANS` to v3 slugs. Update `CREDIT_PACKS` to v3 slugs. |
| `packages/billing/src/cost-table.ts` | **Created.** This is the new single source of truth. (File exists — written as part of this reference.) |
| `packages/config/src/env.ts` | Add `REDIS_URL: z.string().url().optional()` to `baseEnvSchema`. |
| `packages/billing/src/__tests__/cost-table.test.ts` | Create: verify margin >= 65% for all entries, `creditChargeForTokens` boundary cases. |

**Acceptance criteria:**
- [ ] `resolveRate("claude-opus-4-7")` returns $5.00/$25.00
- [ ] `resolveRate("claude-opus-4-7-20260520")` resolves to same entry via prefix match
- [ ] `resolveMeterMarkup()` with v3 weights returns ~2.9086
- [ ] All cost-table margin assertions pass in unit tests
- [ ] `tsc --noEmit` passes with zero errors

#### Step 2 — Organization signup credit grant

**Why:** New orgs land with zero credits and cannot send a single message.

**Files to create/modify:**

| File | Change |
|---|---|
| `apps/api/src/routes/organizations.ts` (or org creation path) | Call `grantCredits(orgId, 500, { reason: "grant_signup" })` after org record is committed. |
| `packages/billing/src/__tests__/grants.test.ts` | Add test: create org → assert `credit_balances.balance_cents = 500`. |

**Acceptance criteria:**
- [ ] New org creation results in 500 credits in `credit_balances`
- [ ] `credit_ledger` has one row: `delta_credits = 500`, `reason = "grant_signup"`
- [ ] Integration test passes against test DB

#### Step 3 — Tool call flat fees

**Why:** Tool calls that bypass the LLM gate are currently uncharged.

**Files to create/modify:**

| File | Change |
|---|---|
| `packages/ai/src/materialize-tools.ts` | In `execute` closure for `web_search`: call `grantCredits(orgId, -1, { reason: "consume_tool_call", referenceId: toolCallId })`. Same for `code_sandbox:execute` at -2 credits. |
| `packages/billing/src/__tests__/metering.test.ts` | Add test: verify `web_search` tool call debits 1 credit, `code_sandbox` debits 2. |

**Acceptance criteria:**
- [ ] `web_search` tool call produces a ledger row with `delta_credits = -1`
- [ ] `code_sandbox:execute` produces a ledger row with `delta_credits = -2`
- [ ] Zero-balance org's tool call triggers CHECK violation + rolls back cleanly (no free tool calls)

#### Step 4 — Pre-turn admission gate + double-spend fix

**Why:** Without the gate, zero-balance orgs get free turns. Double-spend race is a real billing integrity issue.

**Files to create/modify:**

| File | Change |
|---|---|
| `apps/app/src/app/api/chat/stream/route.ts` | Add `hasCreditBalance(orgId)` check before `streamAgentReply`. Return HTTP 402 on false. |
| `apps/api/src/routes/agent.ts` (or equivalent API surface) | Same gate for direct API calls. |
| `packages/billing/src/metering.ts` | Fix `chargeUsageCredits`: move balance read inside transaction with `SELECT ... FOR UPDATE`. |
| `packages/billing/src/credits.ts` | Add `FOR UPDATE` to the balance row read inside `grantCredits` transaction. |
| `packages/billing/src/__tests__/metering.test.ts` | Add concurrency test: two simultaneous charge calls for a 1-credit balance result in exactly one charge of 1 credit, not two charges. |

**Acceptance criteria:**
- [ ] `POST /api/chat/stream` with zero-balance org returns 402 with `{ error: "insufficient_credits" }`
- [ ] Concurrent charge calls pass concurrency test (no double-spend)
- [ ] `hasCreditBalance` correctly returns false for `balance_cents = 0`

#### Step 5 — Ledger `reference_id` reconciliation fix

**Why:** Plan renewal ledger rows have `reference_id: null`, making Stripe invoice reconciliation impossible.

**Files to create/modify:**

| File | Change |
|---|---|
| `packages/billing/src/grants.ts` | In `grantPlanCreditsForInvoicePaid`, look up internal invoice UUID from `billing.invoices` by `stripe_invoice_id`. Pass that UUID as `referenceId` to `grantCredits`. |
| `packages/database/src/migrations/` | If `billing.invoices` table does not exist or lacks `stripe_invoice_id`, add migration to create/alter it. |

**Acceptance criteria:**
- [ ] Every plan renewal ledger row has a non-null `reference_id` (internal UUID)
- [ ] `reference_id` joins to `billing.invoices.id`

#### Step 6 — Stripe v3 product sync

**Why:** v3 Stripe products (starter-v3, growth-v3, scale-v3, 4 credit packs) do not exist in Stripe yet.

**Files to create/modify:**

| File | Change |
|---|---|
| `packages/billing/src/stripe-sync.ts` | Read `stripe-products.json`. For each product/price: check if product with `metadata.slug` exists; if not, create. Set `OXAGEN_METER_MARKUP` in env to solved value (~2.9086) after sync. |
| `scripts/billing-stripe-sync.ts` | CLI entry point: `pnpm billing:stripe-sync [--apply] [--dry-run]`. |
| `package.json` (root) | Add `"billing:stripe-sync": "tsx scripts/billing-stripe-sync.ts"`. |
| `packages/database/src/migrations/` | Migration: insert v3 plans into `billing.plans` table. Archive v2 plans (set `archived_at`). |

**Acceptance criteria:**
- [ ] `pnpm billing:stripe-sync --dry-run` lists all 10 products/14 prices without creating them
- [ ] `pnpm billing:stripe-sync --apply` creates all products/prices in Stripe test mode
- [ ] `billing.plans` has rows for starter-v3, growth-v3, scale-v3

#### Step 7 — Real-time credit chip (A1)

**Why:** Users have no visibility into credit consumption during or after a chat turn.

**Files to create/modify:**

| File | Change |
|---|---|
| `packages/ai/src/stream-event-types.ts` | Add `CreditDeltaEvent` type to `StreamEvent` union. |
| `apps/app/src/app/api/chat/stream/route.ts` | After `chargeUsageCredits` returns, emit `credit-delta` event into the stream. |
| `apps/app/src/contexts/CreditBalanceContext.tsx` | Create: balance state, `setBalance`, `CreditBalanceProvider`. |
| `apps/app/src/app/[orgSlug]/layout.tsx` | Wrap children with `CreditBalanceProvider initialBalance={await getOrgCreditBalance(orgSlug)}`. |
| `apps/app/src/components/chat/ChatShellClient.tsx` | Handle `credit-delta` event → call `creditBalanceCtx.setBalance()`. |
| `apps/app/src/components/CreditChip.tsx` | Create: reads `useCreditBalance()`, displays formatted credits with animate-down transition. |

**Acceptance criteria:**
- [ ] Credit chip shows initial balance on page load (SSR from Postgres)
- [ ] Credit chip animates down after a chat turn completes
- [ ] `tsc --noEmit` passes on all new files

#### Step 8 — Billing page: credit pack purchase UI

**Why:** Users have no in-app path to buy credits.

**Files to create/modify:**

| File | Change |
|---|---|
| `apps/app/src/app/[orgSlug]/settings/billing/page.tsx` | Add v3 tier cards, credit pack purchase cards, ledger table, usage chart. |
| `apps/app/src/app/api/billing/ledger/route.ts` | Create: paginated `credit_ledger` query for org. |
| `apps/app/src/app/api/billing/balance/route.ts` | Create: current `credit_balances` for org. |
| `apps/app/src/app/api/billing/usage/route.ts` | Create: 30-day rolling usage aggregation from ClickHouse. |

**Acceptance criteria:**
- [ ] Billing page renders with current balance, plan, and ledger rows
- [ ] "Buy" button on a credit pack redirects to Stripe Checkout
- [ ] After successful checkout, balance updates within one webhook cycle
- [ ] Low-balance warning appears at ≤ 500 / 2,000 / 5,000 credits (Starter/Growth/Scale)

#### Steps 9-12 (follow-on, post-launch)

| Step | Work | Ticket |
|---|---|---|
| 9 | Auto-top-up: `billing.auto_top_up_configs` table + off-session Stripe PaymentIntent | File after Customer Portal confirmed |
| 10 | Redis pub/sub (A3): `redis-client.ts`, `publishCreditBalance`, cross-surface balance SSE | File after first external surface (agents page) needs live balance |
| 11 | Per-workspace credit budgets (Growth+): `billing.workspace_budgets` table + enforcement at gate | File alongside workspace management feature |
| 12 | Usage analytics dashboard: ClickHouse aggregation queries + charts | File after ClickHouse schema is stable |

## Document — `pricing-and-metering.md`

## Billing: Pricing, Credits & the Usage Meter

**Status:** active · **Owner:** Mac Anderson · **Last sync:** 2026-05-31 (Stripe **test** mode)

This document describes how Oxagen prices its products, how the usage **gate**
charges customers for what providers (Anthropic, OpenAI) bill us, and how a
single target-margin knob drives every Stripe price. For the day-to-day "how do
I change a price / re-sync Stripe" runbook, see
[`docs/ops/stripe-product-sync-sop.md`](../../ops/stripe-product-sync-sop.md).

---

### 1. The one-paragraph model

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

### 2. Why margin lives in the meter (not the price)

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

### 3. The cost meter (provider rate card)

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

### 4. The blended-margin solve

```
margin_i  = 1 − creditsPerCent_i / markup        # creditsPerCent = credits ÷ price_in_cents
blended   = Σ wᵢ · margin_i                        # wᵢ = expected revenue mix
set blended = m  ⟹  markup = Σ (wᵢ · creditsPerCent_i) / (1 − m)
```

`creditsPerCent` is "how many credits a cent buys": face value = 1.0,
subscriptions/bonus packs > 1.0 (more generous → lower margin). The solve and
the full derivation are pure functions (`solveMeterMarkup`, `derivePricing`) and
are unit-tested to satisfy `derivePricing(m).blendedMargin === m` for every m.

#### Current model @ target 65%

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

### 5. The gate (where credits are charged)

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

#### Safety: no overdraft

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

### 6. The grant side (where credits are deposited)

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

### 7. Products & the source of truth

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

### 8. Runtime configuration

| Env var | Meaning | Default |
|---|---|---|
| `OXAGEN_TARGET_MARGIN` | Target blended gross margin (0,1). Drives the solve. | `0.65` (DEFAULT_TARGET_MARGIN) |
| `OXAGEN_METER_MARKUP` | Optional hard pin of the solved markup so runtime never recomputes. | unset → derived from target + mix |

Both are registered in `packages/config/src/env.ts` and the Vercel env catalog
(`tools/env-manager/src/catalog.ts`, `OXAGEN_TARGET_MARGIN` static `0.65` across
envs). Leaving `OXAGEN_METER_MARKUP` unset keeps a single source of truth (the
code); pinning it decouples runtime from a config edit until the next sync.

---

### 9. Bugs fixed by this work

- `token_usage.cost_usd_micros` was hard-coded to `0` in the gate and embeddings
  → now priced via the rate card.
- `providerFromModelId` returned `""` for the bare model ids the gate actually
  uses (`claude-sonnet-5`) → now infers the provider from the family.
- Credits were **never** charged on LLM calls and **never** granted on
  purchase/renewal → both halves of the loop are now wired.
- `billing.plans` seed carried placeholder Stripe ids and unrealistic
  `includedCreditCents` (e.g. 500,000) → real synced values.

---

### 10. Files

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

