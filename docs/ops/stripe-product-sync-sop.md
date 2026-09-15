# SOP: Stripe Product Sync and the List Price Book

**Standard operating procedure** for keeping three things in sync with
`packages/billing/src/pricing.ts`: Oxagen's Stripe catalogue, the
`billing.plans` table, and the list price book (`cost.price_entries`). The
billing model is governed action units (GAUs): monthly buckets bought in unit
quantities at a contracted rate.

Background: [ADR-055](../adr/ADR-055-gau-buckets-and-contracted-rates.md),
[`docs/specs/governed-action-metering.md`](../specs/governed-action-metering.md)
§4 (the published figures), `apps/app/ARCHITECTURE.md` §3.9 (the recorder,
the settlements and the Stripe objects), ADR-060 §1 (the price book).

---

## TL;DR

```bash
pnpm billing:stripe-sync --report          # catalogue + credit margins (no network)
pnpm billing:stripe-sync                   # DRY-RUN against Stripe (no writes)
pnpm billing:stripe-sync --apply           # reconcile Stripe + billing.plans
pnpm billing:price-book-sync               # DRY-RUN of the list price book
pnpm billing:price-book-sync --apply       # write cost.price_entries (org_id NULL)
```

`packages/billing/src/pricing.ts` is the single source of truth: edit it,
then re-run the script. Never create or edit prices by hand in the Stripe
dashboard. The scripts are idempotent and the dashboard is not the source of
truth.

---

## 0. Which Stripe account am I hitting?

The script uses whatever `STRIPE_SECRET_KEY` is in scope and **prints the mode**:

- `sk_test_…` → a **test-mode** account. The banner prints `test`.
- `sk_live_…` → a **LIVE** account. The banner prints `LIVE` in red.

**Until the production cutover, every environment binds to one shared Stripe
sandbox (`acct_1Ty2gjK5L8c4uZ0j`, test mode). That covers local, CI and
production (`https://app.oxagen.sh`, `https://api.oxagen.sh`). The banner
must read `test` everywhere. A `LIVE` banner today means the wrong key is in
scope: stop.**
[`docs/ops/stripe-sandbox-mode.md`](stripe-sandbox-mode.md) records where the
sandbox key set lives and how to rotate it. Switching production to live keys
is a deliberate, separate step the maintainer takes (§7). Nothing else in
this SOP does it.

`billing:price-book-sync` makes no Stripe calls. It writes to whatever
`DATABASE_URL` is in scope and prints the host.

---

## 1. What the catalogue holds

| Product | Defined in | Stripe objects | Database rows | Sold through |
|---|---|---|---|---|
| **Free** | `FREE_PLAN_SLUG`, seeded by `seedPlatform` (#3070) | none | a `billing.plans` row with Free's GAU terms (5,000 GAU a month) | nothing; an org with no subscription is on Free |
| **Build**, **Scale** | `SUBSCRIPTION_PLANS` (`build-v2`, `scale-v2`) | one product per plan with a monthly and an annual price, lookup keys `build_v2_month` / `build_v2_year` and `scale_v2_month` / `scale_v2_year` | a `billing.plans` row per plan: prices, seats, `included_credit_cents`, and the four GAU terms from `gauTerms` (`currency`, `rate_per_gau_micros`, `block_size_gau`, `included_gau_per_month`) | `start_subscription_upgrade` → Stripe Checkout, the in-app Build/Scale upgrade rev1 keeps (maintainer decision, 2026-09-15) |
| **Credit packs** | `CREDIT_PACKS` (Starter, Power, Scale) | one product and one one-time price per pack (`oxagen_kind: credit_pack`) | none | `purchase_credits`: the in-app agent's top-up of the ADR-053 platform-funded balance, kept by the maintainer decision of 2026-09-15 |
| **GAU block** | added by WL-57 | one product and one published block price with a lookup key | none | `purchase_gau_bucket` (Checkout) and the GAU invoices: auto top-up, interim, period close |
| **Enterprise** | nothing: negotiated only (maintainer decision, 2026-09-15) | none | one `billing.contract_terms` row per organisation, written by an operator migration | a negotiated contract |

Two rows describe work still in flight:

- **GAU block.** Until WL-57 lands, the block has no catalogue entry. The
  Checkout sells it with a `price_data` line at the organisation's contracted
  rate, and each invoice item carries `unit_amount_decimal` (ARCHITECTURE
  §3.9 item 11).
- **Enterprise.** Until WL-56 lands, `enterprise-v2` is still in
  `SUBSCRIPTION_PLANS`, and `--apply` still writes its product, its two
  prices and a `billing.plans` row carrying the Scale GAU figures. No new
  organisation is sold that plan.

A GAU is never bought with credits, and a credit pack never buys GAUs. The
two products do not share a balance.

---

## 2. Change a plan's price, a plan's GAU terms, or a credit pack

1. Edit `SUBSCRIPTION_PLANS` or `CREDIT_PACKS` in
   `packages/billing/src/pricing.ts`.
   - Keep the **display name** clean (no `-v2`) and keep the **slug**
     suffixed (`…-v2`). `tier` must be one of `free | build | scale |
     enterprise`, the `billing.plans.tier` CHECK.
   - `gauTerms` must satisfy `(ratePerGauMicros × blockSizeGau) % 10000 === 0`,
     the `plans_gau_terms_check` CHECK, so a block prices to whole cents.
   - The published GAU figures are owned by the spec (metering spec §4.2).
     A change to a rate, block size or allowance is a maintainer decision:
     record it in the spec with its date before editing `pricing.ts`.
2. `pnpm billing:stripe-sync --report` to sanity-check the table.
3. `pnpm billing:stripe-sync` to dry-run. Read the planned `CREATE` /
   `UPDATE` / `reuse` lines.
4. `pnpm billing:stripe-sync --apply` to write it.

**Editing an existing price:** Stripe prices are immutable. When an amount
changes, the script creates a **new** price carrying the same `lookup_key`
(`transfer_lookup_key`), archives the old one, and repoints `billing.plans`.
Existing subscriptions stay on their old price until migrated. Stripe
intends this.

**Editing GAU terms:** `resolveContractTerms` reads `billing.plans` live.
Every organisation on that published plan gets the new terms on its next
read and its next settlement. A settlement already written keeps the rate it
charged. Negotiated `contract_terms` rows are unaffected.

**Removing a plan:** the sync hides (`is_public = false`) any public plan
whose slug is neither Free nor in `SUBSCRIPTION_PLANS`
(`tools/scripts/stripe-sync.ts`, "Reconcile deletions"). It never deletes
the row, because subscriptions reference it.

---

## 3. The margin knob: credits only

The credit-margin solve is still in the code (`derivePricing`,
`OXAGEN_TARGET_MARGIN`, `OXAGEN_METER_MARKUP`, `PROVIDER_RATE_CARD`). It
covers credits (1 credit = $0.01) and nothing else:

- the credit packs,
- the `includedCredits` a plan invoice grants,
- the meter markup at which a platform-funded assistant turn debits credits
  (metering spec §5.3).

It sets no GAU figure. The GAU rate, block size and allowance are
`gauTerms`, and a margin change moves none of them.

```bash
# 1. Model it first — no writes, no network:
pnpm billing:stripe-sync --margin=0.70 --report
```

The report prints the new **meter markup**, the per-product realised credit
margins, the blended margin (equal to your target), and the exact env line to
set.

```bash
# 2. Make it the default everywhere:
#    - set OXAGEN_TARGET_MARGIN in the env catalog + envs (see §5), AND/OR
#    - change DEFAULT_TARGET_MARGIN in packages/billing/src/pricing.ts
# 3. Push product metadata (target margin, markup, realised margin) to Stripe:
pnpm billing:stripe-sync --apply
# 4. Set the runtime markup to match:
OXAGEN_METER_MARKUP=<printed value>     # or leave unset to derive from target
```

| You want to change… | Lever | Effect |
|---|---|---|
| A plan's advertised $ price | `monthlyCents` / `annualCents` | New Stripe price |
| A plan's GAU allowance, rate or block size | `gauTerms`, after the spec records the decision (§2) | `billing.plans` terms; live on the next read |
| A credit pack's price or credits | `priceCents` / `credits` | New Stripe price; recomputed credit margin |
| The credit margin | `OXAGEN_TARGET_MARGIN` / `--margin` | Meter markup and realised credit margins; no GAU figure moves |
| What providers cost us | `PROVIDER_RATE_CARD` | Credits per platform-funded assistant call; the list price book (§4) |
| The revenue mix assumption | `weight` per product | The solved markup only |

---

## 4. Update provider rates (when a provider invoice changes)

1. Edit `PROVIDER_RATE_CARD` in `pricing.ts` to match the new invoice.
2. `pnpm billing:stripe-sync --apply` refreshes product metadata. Prices are
   anchored and do not move.
3. `pnpm billing:price-book-sync --apply` writes the new list rows to
   `cost.price_entries` (`org_id` NULL, source `list`). They take effect from
   the top of the current UTC hour, or from `--effective-from=<RFC 3339>`.
   A later run closes the previous rows at its own instant. A run that would
   start before an open row is refused. Negotiated and override rows are
   never touched (ADR-060 §1).
4. No env change is needed. The assistant path reads the rate card directly
   at runtime, and the Spend rollup reads the price book.

---

## 5. Set the runtime env

| Env var | Where | Value |
|---|---|---|
| `OXAGEN_TARGET_MARGIN` | env registry (`packages/config/src/registry.ts`), `.env.local`, Parameter Store `/oxagen/production/` | e.g. `0.65` |
| `OXAGEN_METER_MARKUP` | optional pin; `.env.local` / Parameter Store | the value the script prints, e.g. `3.3190` |

Production is AWS: an EC2 node reads `/oxagen/production/` from Parameter
Store at container start (see `README.md` → Deployment). Vercel is not a
deploy target. Locally, `.env.local` already carries `OXAGEN_TARGET_MARGIN`.

---

## 6. Production run order: HELD (maintainer decision, 2026-09-15)

The maintainer decided the order for bringing production onto this
catalogue:

1. Migrate the production database (`db-migrate.yml`).
2. Run `stripe-sync` against production (`stripe-sync.yml`, dispatched with
   `apply`). It uses the sandbox key production holds (§0).
3. Run `billing:price-book-sync --apply` with the production `DATABASE_URL`
   from Parameter Store.

**All three steps are held.** The `app-rebuild` migrations are not purely
additive, so step 1 waits on a check of every non-additive statement against
production data. Do not run any of the three steps against production until
the maintainer lifts the hold.

---

## 7. Promote to LIVE (production): not yet done; maintainer decision

Production runs the sandbox today (§0). When the maintainer decides to go
live:

1. Confirm the model in the sandbox: `--report` and a sandbox `--apply` look
   right.
2. Write the live `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` /
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` to Parameter Store and create the live
   webhook endpoint (its `whsec_` → `STRIPE_WEBHOOK_SECRET`), following the
   rotation recipe in `docs/ops/stripe-sandbox-mode.md`. Restart `api`, then
   merge to `main` so `app` rebuilds with the inlined publishable key.
3. With the live key in scope, run `pnpm billing:stripe-sync --apply`. The
   banner must read `LIVE`.
4. Verify in the Stripe dashboard: one product per slug with
   `oxagen_slug` / `oxagen_version=v2` metadata, and one active price per
   lookup key. Once WL-56 and WL-57 have landed, that means Build, Scale,
   the three credit packs and the GAU block product. Before then it means
   the three plans (Enterprise included) and the three packs.
5. Ensure the live webhook endpoint forwards every event
   `packages/billing/src/stripe-provider.ts` `stripeEventType()` maps
   (`invoice.*`, `checkout.session.completed`, `customer.subscription.*`,
   `payment_method.*`, `charge.dispute.*`, `charge.refunded`), so GAU
   grants, settlements and credit grants fire.
6. Update §0 of this SOP and the registry descriptions in
   `packages/config/src/registry.ts` so they stop saying "sandbox everywhere".

---

## 8. Verify after any sync

```bash
# Idempotency: a second --apply must show UPDATE/reuse, never CREATE.
pnpm billing:stripe-sync --apply

# Stripe-side: exactly one product per slug, one active price per lookup_key
# (the script's report + the Stripe dashboard).

# DB-side: every public plan carries its GAU terms.
psql "$DATABASE_URL" -c \
  "select slug, tier, monthly_cents, included_gau_per_month, rate_per_gau_micros, block_size_gau, currency, stripe_product_id from billing.plans where is_public order by monthly_cents;"
```

---

## 9. Flags reference

`billing:stripe-sync`:

| Flag | Effect |
|---|---|
| *(none)* | Report + **dry-run** (reads Stripe, writes nothing) |
| `--report` | Report only: pure, no Stripe/DB calls |
| `--apply` | Create/update Stripe products+prices, upsert `billing.plans`, hide plans outside the source of truth |
| `--margin=0.70` | Model/apply a different credit margin for this run |
| `--no-db` | Skip the `billing.plans` upsert (Stripe only) |

`billing:price-book-sync`:

| Flag | Effect |
|---|---|
| *(none)* | Report + **dry-run** (writes nothing) |
| `--apply` | Write the list rows to `cost.price_entries` |
| `--effective-from=<RFC 3339>` | Start the rows at this instant (default: the top of the current UTC hour) |

---

## 10. Rollback

- **Bad price:** revert the `pricing.ts` change and `--apply` again. The
  script transfers the lookup key back to a price with the prior amount.
- **Bad GAU terms:** revert `gauTerms` and `--apply` again. Settlements
  written in between keep the rate they charged; correct a mis-charge with a
  Stripe credit note, never by editing a settlement row.
- **Bad margin:** reset `OXAGEN_TARGET_MARGIN` / `OXAGEN_METER_MARKUP` to the
  previous values and `--apply` to refresh metadata.
- **Bad price book row:** run `billing:price-book-sync --apply` again with
  the corrected rate card. The correction is a later row, and cost records
  already priced keep the entry they were priced with.
- **Products created in error (test):** archive them in the Stripe dashboard
  (`active=false`). They no longer resolve by `lookup_key`, so the next
  `--apply` recreates clean ones.
