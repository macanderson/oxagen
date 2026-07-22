---
# Revenue / Reseller

- **Route:** `/{orgSlug}/billing/revenue`
- **Nav location:** org → Billing & Revenue → tab "Revenue"
- **Priority:** P1
- **Disposition vs today:** New (the clearest market whitespace in the vision)

## Purpose
Revenue is where a team that resells AI agents turns observed usage into billing for *their own customers* — the literal "Stripe for agents" surface. Nobody in the market lets a reseller meter observed agent usage per end-customer and push that straight to a Stripe invoice; this page packages the existing ClickHouse→Stripe loop for that exact job, distinct from Usage (the org's own consumption) and Subscription (the org's own Stripe plan).

## Primary user & jobs-to-be-done
- **Primary user:** Reseller billing manager (an org that resells agents to its own customers)
- **JTBD:**
  - Define the end-customer accounts I bill, separate from my own org membership.
  - Map observed usage (by acting principal, workspace, or capability) to the right customer.
  - Set a markup or price plan on top of raw metered cost per customer.
  - Preview what a customer's next invoice will look like before it goes out.
  - Push priced usage to Stripe as that customer's invoice or metered subscription item.
  - See revenue per customer, not just cost per workspace.

## Functionality
- **Customer accounts table:** name, external ref, assigned price plan, current-period usage, projected revenue, status (active/paused).
- **Attribution rules:** map acting principal / workspace / capability → customer account (rule list + add/edit).
- **Price plans:** markup percentage or flat per-unit price on top of raw metered cost, one or more plans assignable to customers.
- **Re-bill preview:** per-customer projected invoice (line items from attributed usage × price plan) before pushing to Stripe.
- **Push to Stripe action:** creates/updates the customer's Stripe invoice or metered subscription item.
- **Per-customer usage → revenue table:** historical view once re-bills have been pushed.

## Capabilities invoked
- `billing.usage.breakdown` (`get_usage_breakdown`) — sliced by acting principal/workspace to build customer attribution.
- `billing.subscription_upgrade.start` (`start_subscription_upgrade`) — reused Stripe checkout/invoicing plumbing where applicable.
- **Contract gap (large):** reseller primitives do not exist yet. Author contracts for: customer-account CRUD, usage→customer attribution rules, meter/price-plan mapping, and re-bill push to Stripe (contract → API → MCP → UI is law). This is a substantial build — open a Linear sub-issue under a Revenue/Reseller milestone before implementation; likely Opus/Fable-tier effort.

## Data sources
ClickHouse (usage, via `get_usage_breakdown`) → Postgres (new customer/attribution/price-plan tables) → Stripe (customer invoices/metered items).

## States
- **Empty:** "No customer accounts yet — add your first customer" before any are defined.
- **Loading:** skeleton customer table and preview panel while usage attribution resolves.
- **Error:** Stripe push failure shows per-customer inline error with retry, distinct from attribution-rule save failures.

## Existing implementation
- **Today:** no equivalent page or contracts exist; this is new build on top of existing usage metering.

## Vision alignment
The single most vision-defining new surface — "Stripe for agents," literally, for teams that resell agents to their own customers. P1 despite being new because it is the clearest expression of the market whitespace the whole platform is built to own.
