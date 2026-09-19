# start_subscription_upgrade

**Domain:** billing
**Mode:** sync
**Surfaces:** api, mcp, agent
**Scope:** tenant + workspace
**Risk:** medium · requires approval

## Intent

Begin a plan change. Returns a Stripe Checkout URL the user opens (in-app
redirect, MCP-returned link, or API consumer's choice). The subscription
flips only after Stripe's `customer.subscription.updated` webhook lands
at `apps/api /webhooks/stripe`; this capability does not complete the
upgrade itself.

The in-app agent uses this to surface upgrade prompts mid-conversation —
on approval the chat UI opens the URL in a new tab and the user
completes payment there.

In the app, the Billing page's **Change plan** button opens a dialog that
offers Build and Scale, monthly or yearly, and sends the browser to Checkout
(`apps/app/src/features/billing/change-plan.tsx`, `startPlanChange` in
`actions.ts`). Checkout returns to `/{org}/billing?checkout=plan`, or
`?checkout=cancel`. Enterprise is negotiated per contract and is not offered.
The plans the dialog offers, and the figures the page's price list prints,
are `UPGRADE_PLANS` and `PUBLISHED_TERMS` on the contract module;
`packages/billing/src/pricing.test.ts` holds them equal to
`SUBSCRIPTION_PLANS`.

## Authorization

Org Owner or Billing, checked in the handler with `assertOrgRole` for the
signed-in user or the API key's creator. The kernel's IAM check allows every
capability on a non-enterprise org, so the handler owns this gate.

`noBillingGate: true` (INV-27): starting Checkout is never refused for lack of
GAUs. A prepaid organisation at `remaining = 0` is the one that needs to
upgrade; metering this invoke as a governed action blocked that path.

## Input

| Field | Type | Description |
| --- | --- | --- |
| `planSlug` | string | Target plan slug from `billing.plans` |
| `interval` | `"month" \| "year"` | Billing interval |
| `successUrl` | URL | Return URL after successful checkout |
| `cancelUrl` | URL | Return URL after canceled checkout |

## Output

| Field | Type | Description |
| --- | --- | --- |
| `checkoutUrl` | URL | Stripe-hosted checkout URL |
| `planSlug` | string | Echoed input |
| `interval` | `"month" \| "year"` | Echoed input |

## Side effects

- Postgres: no writes (subscription updates happen via webhook).
- ClickHouse: `tool_invocations` row for the agent call.
- Stripe: a Checkout Session is created.

## Errors

| code | meaning |
| --- | --- |
| `forbidden` | The caller is neither an org Owner nor a Billing member |
| `conflict` (`active_subscription_exists`) | The organization already has an active or trialing subscription; Checkout does not start a second one |
| `plan_not_found` | The `planSlug` doesn't match any row in `billing.plans` |
| `price_missing` | The plan has no Stripe price ID for the requested interval |
| `stripe_no_url` | Stripe returned a session without a URL — provider issue |

## SPEC references

- `docs/epics/foundations/spec.md` §6.13 billing
- Memory: [[no-drift-across-surfaces]] — present on api, mcp, agent
