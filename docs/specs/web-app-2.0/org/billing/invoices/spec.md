---
# Billing — Invoices

- **Route:** `/{orgSlug}/billing/invoices`
- **Nav location:** org → Billing & Revenue → tab "Invoices"
- **Priority:** P2
- **Disposition vs today:** Keep

## Purpose
Invoices is the customer-facing artifact list that closes the billing loop — the org's own Stripe-synced invoice history, viewable and downloadable without leaving Oxagen. It complements Usage (what happened) and Subscription (current plan/credits) with the concrete billing documents themselves.

## Primary user & jobs-to-be-done
- **Primary user:** Any org member with billing visibility (read is laxer than Usage)
- **JTBD:**
  - Find and download a past invoice for expense reporting or accounting.
  - Confirm an invoice's amount and line items match expected usage/plan.
  - Access the hosted Stripe invoice page for payment or dispute.

## Functionality
- **Invoice list:** last 25 invoices, columns — invoice number/date, amount, status (paid/open/void), actions (view hosted page, download PDF).
- No filtering/search in current scope (25-row cap is the whole list); pagination not yet needed at this volume.

## Capabilities invoked
- No dedicated contract — direct DB read of Stripe-synced invoice rows via `withTenantDb`.

## Data sources
Postgres (invoice rows synced from Stripe) + Stripe (hosted invoice page, PDF links).

## States
- **Empty:** "No invoices yet" for a brand-new org before first billing cycle.
- **Loading:** skeleton list rows while the tenant-scoped query resolves.
- **Error:** query failure shows inline banner with retry; individual broken Stripe links degrade to a disabled action with tooltip rather than a dead link.

## Existing implementation
- **Today:** COMPLETE — last 25 invoices via `withTenantDb` → `InvoiceList` component (hosted/PDF links); read gated by plain org membership, which is laxer than the Usage tab's `assertBillingManager` gate — likely intentional since usage exposes cross-workspace cost detail that invoices don't. Worth documenting this asymmetry explicitly rather than treating it as a gap.

## Vision alignment
Closes the billing loop with the customer-facing artifact — the concrete document the metering→billing pipeline ultimately produces. P2 because it's a read-only convenience view over data Stripe already owns, not new wedge surface.
