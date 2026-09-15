# SOP: Stripe Product Sync & Re-pricing

**Standard operating procedure** for keeping Oxagen's Stripe products/prices and
the `billing.plans` table in sync with the pricing model, and for re-pricing to
a new profit-margin objective.

Background & the why: [`docs/architecture/billing/pricing-and-metering.md`](../architecture/billing/pricing-and-metering.md).

---

## TL;DR

```bash
pnpm billing:stripe-sync --report          # see the model + margins (no network)
pnpm billing:stripe-sync                   # DRY-RUN against Stripe (no writes)
pnpm billing:stripe-sync --apply           # reconcile Stripe + billing.plans
```

The single source of truth is `packages/billing/src/pricing.ts`. **Edit it,
re-run the script.** Never click prices together by hand in the Stripe
dashboard — the script is idempotent and the dashboard is not the source of
truth.

---

## 0. Which Stripe account am I hitting?

The script uses whatever `STRIPE_SECRET_KEY` is in scope and **prints the mode**:

- `sk_test_…` → a **test-mode** account. The banner prints `test`.
- `sk_live_…` → a **LIVE** account. The banner prints `LIVE` in red.

**Until the production cutover, every environment — local, CI and production
(`https://app.oxagen.sh`, `https://api.oxagen.sh`) — binds to one shared Stripe
sandbox (`acct_1Ty2gjK5L8c4uZ0j`, test mode). The banner must read `test`
everywhere; a `LIVE` banner today means the wrong key is in scope. Stop.**
[`docs/ops/stripe-sandbox-mode.md`](stripe-sandbox-mode.md) records where the
sandbox key set lives and how to rotate it. The maintainer switches production
to live keys as a deliberate, separate step (§5); nothing in this SOP does it
implicitly.

---

## 1. Change a product's price, credits, or add a product

1. Edit `SUBSCRIPTION_PLANS` / `CREDIT_PACKS` in
   `packages/billing/src/pricing.ts`.
   - Keep the **display name** clean (no `-v2`); keep the **slug** suffixed
     (`…-v2`). Slug + display name are required; `tier` must be
     `free | pro | enterprise`.
2. `pnpm billing:stripe-sync --report` — sanity-check the table and the blended
   margin.
3. `pnpm billing:stripe-sync` — dry-run; read the planned `CREATE/UPDATE/reuse`.
4. `pnpm billing:stripe-sync --apply` — write it.

**Editing an existing price:** Stripe prices are immutable. When an amount
changes the script creates a **new** price carrying the same `lookup_key`
(`transfer_lookup_key`), archives the old one, and repoints `billing.plans`.
Existing subscriptions stay on their old price until migrated — that is Stripe's
intended behaviour, not a bug.

---

## 2. ⭐ Re-price to a new profit-margin objective

This is the headline workflow: **input a desired margin → all pricing reflects
it.**

```bash
# 1. Model it first — no writes, no network:
pnpm billing:stripe-sync --margin=0.70 --report
```

The report prints the new **meter markup**, the per-product realised margins,
the blended margin (== your target), and the exact env line to set.

```bash
# 2. Make it the default everywhere:
#    - set OXAGEN_TARGET_MARGIN in the env catalog + envs (see §4), AND/OR
#    - change DEFAULT_TARGET_MARGIN in packages/billing/src/pricing.ts
# 3. Push product metadata (target margin, markup, realised margin) to Stripe:
pnpm billing:stripe-sync --apply
# 4. Set the runtime gate to match:
OXAGEN_METER_MARKUP=<printed value>     # or leave unset to derive from target
```

### What actually changes when you change the margin

Because **1 credit = $0.01 is locked**, the margin knob moves the **meter
markup** (how fast a call burns credits) and the **product metadata** on Stripe
(`oxagen_target_margin`, `oxagen_meter_markup`, `margin_pct`) — **not** the
dollar sticker prices. Higher target → credits burn faster → higher realised
margin, same advertised prices.

| You want to change… | Lever | Effect |
|---|---|---|
| Overall profit margin | `OXAGEN_TARGET_MARGIN` / `--margin` | Meter markup + realised margins; sticker prices unchanged |
| A plan's advertised $ price | `monthlyCents` / `priceCents` in `pricing.ts` | New Stripe price; recomputed margin |
| A subscription's incentive (discount) | `includedCredits` vs `monthlyCents` | More credits per $ → bigger discount, lower that plan's margin |
| What providers cost us | `PROVIDER_RATE_CARD` | Credits-per-call at the gate; margins unchanged (markup is relative) |
| The revenue mix assumption | `weight` per product | The solved markup only |

> If you need the **advertised dollar prices** to move with margin (rather than
> the meter), that requires abandoning the $0.01 credit anchor — a business
> decision, not a config change. The current model is the internally consistent
> one given that anchor. See §2 of the architecture doc.

---

## 3. Update provider rates (when an invoice changes)

1. Edit `PROVIDER_RATE_CARD` in `pricing.ts` to match the new provider invoice.
2. `pnpm billing:stripe-sync --apply` (refreshes product metadata; prices are
   anchored so they won't move).
3. No env change needed — the gate reads the rate card directly at runtime.

Margins are preserved automatically: a higher provider cost simply debits more
credits per call (the markup is a multiplier on cost), so the customer absorbs
the increase and the margin percentage holds.

---

## 4. Set the runtime env

| Env var | Where | Value |
|---|---|---|
| `OXAGEN_TARGET_MARGIN` | env registry (`packages/config/src/registry.ts`), `.env.local`, Parameter Store `/oxagen/production/` | e.g. `0.65` |
| `OXAGEN_METER_MARKUP` | optional pin; `.env.local` / Parameter Store | the value the script prints, e.g. `3.3190` |

Production is AWS (an EC2 node reading `/oxagen/production/` from Parameter
Store at container start — see `README.md` → Deployment); Vercel is not a
deploy target. Locally, `.env.local` already carries `OXAGEN_TARGET_MARGIN`.

---

## 5. Promote to LIVE (production) — not yet done; maintainer decision

Production runs the sandbox today (§0). When the maintainer decides to go live:

1. Confirm the model in the sandbox: `--report` and a sandbox `--apply` look right.
2. Write the live `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` /
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` to Parameter Store and create the live
   webhook endpoint (its `whsec_` → `STRIPE_WEBHOOK_SECRET`), following the
   rotation recipe in `docs/ops/stripe-sandbox-mode.md`. Restart `api`, then
   merge to `main` so `app` rebuilds with the inlined publishable key.
3. With the live key in scope, run `pnpm billing:stripe-sync --apply`. The
   banner must read `LIVE`.
4. Verify in the Stripe dashboard: 6 products (3 plans + 3 credit packs),
   correct prices, `oxagen_slug` / `oxagen_version=v2` metadata present.
5. Ensure the live webhook endpoint forwards the 20 events
   `packages/billing/src/stripe-provider.ts` `stripeEventType()` maps
   (`invoice.*`, `checkout.session.completed`, `customer.subscription.*`,
   `payment_method.*`, `charge.dispute.*`, `charge.refunded`) so grants fire.
6. Update §0 of this SOP and the registry descriptions in
   `packages/config/src/registry.ts` so they stop saying "sandbox everywhere".

---

## 6. Verify after any sync

```bash
# Idempotency: a second --apply must show UPDATE/reuse, never CREATE.
pnpm billing:stripe-sync --apply

# Stripe-side: exactly one product per slug, one active price per lookup_key
# (the script's report + the Stripe dashboard).

# DB-side:
psql "$DATABASE_URL" -c \
  "select slug, monthly_cents, included_credit_cents, stripe_product_id from billing.plans where slug like '%-v2';"
```

---

## 7. Flags reference

| Flag | Effect |
|---|---|
| *(none)* | Report + **dry-run** (reads Stripe, writes nothing) |
| `--report` | Report only — pure, no Stripe/DB calls |
| `--apply` | Create/update Stripe products+prices, upsert `billing.plans` |
| `--margin=0.70` | Model/apply a different target margin for this run |
| `--no-db` | Skip the `billing.plans` upsert (Stripe only) |

---

## 8. Rollback

- **Bad price:** revert the `pricing.ts` change, `--apply` again — the script
  transfers the lookup key back to a price with the prior amount.
- **Bad margin:** reset `OXAGEN_TARGET_MARGIN` / `OXAGEN_METER_MARKUP` to the
  previous values; `--apply` to refresh metadata.
- **Products created in error (test):** archive them in the Stripe dashboard
  (`active=false`). They no longer resolve by `lookup_key`, so the next
  `--apply` recreates clean ones.
