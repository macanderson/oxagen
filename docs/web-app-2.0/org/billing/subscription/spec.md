---
# Billing — Subscription & Credits

- **Route:** `/{orgSlug}/billing/subscription`
- **Nav location:** org → Billing & Revenue → tab "Subscription"
- **Priority:** P1
- **Disposition vs today:** Keep

## Purpose
This page is where an org manages its own relationship with Oxagen — plan, credit balance, payment methods, and auto-reload — the Stripe side of the metering→billing loop for the org's own consumption. It is the customer-facing mirror of the usage tab: usage shows what happened, subscription shows what it costs and how it's paid for.

## Primary user & jobs-to-be-done
- **Primary user:** Billing manager / owner
- **JTBD:**
  - See current plan, credit balance, and recent ledger activity at a glance.
  - Upgrade or change plan via Stripe checkout.
  - Purchase additional credits when balance runs low.
  - Manage payment methods and auto-reload thresholds.
  - Get warned before service is impacted by low balance or a failed payment.

## Functionality
- **Plan card:** current plan name, price, renewal date, upgrade CTA.
- **Credit balance panel:** current balance, recent ledger entries (table: date, description, amount, running balance).
- **Payment methods:** list of cards, add/remove, set default.
- **Auto-reload settings:** threshold + top-up amount toggle.
- **Banners:** dunning (failed payment) and low-balance warnings, shown above the fold when active.
- Mutations (upgrade, purchase credits, payment method changes) role-gated to owner/admin/billing-manager; each emits a security event.

## Capabilities invoked
- `billing.subscription.read` (`get_subscription`) — current plan/credit state.
- `billing.subscription_upgrade.start` (`start_subscription_upgrade`) — Stripe checkout session for plan change.
- `billing.credits.purchase` (`purchase_credits`) — one-off or auto-reload credit purchase.

## Data sources
Postgres (subscription record, credit ledger) + Stripe (checkout, payment methods, invoicing).

## States
- **Empty:** credit ledger empty on brand-new org ("No activity yet").
- **Loading:** skeleton plan card and ledger table while subscription read resolves.
- **Error:** Stripe checkout failure shows inline toast with retry; ledger read failure shows a banner but doesn't block the plan card.

## Existing implementation
- **Today:** COMPLETE — subscription, credit balance + ledger, plan cards, payment methods, auto-reload, dunning/low-balance banners; mutations role-gated owner/admin/billing, emit security events; direct `@oxagen/billing` calls; Stripe checkout via `start_subscription_upgrade` (API route).
- **Note:** `start_subscription_upgrade` is invoked from the app but its contract omits `app` from `layers[]` — a reverse-parity gap worth declaring.

## Vision alignment
The Stripe side of the metering→billing loop — where observed usage (from the usage tab) actually turns into a paid subscription and credit spend. P1 because billing is a core wedge, not an afterthought.
