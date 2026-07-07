# billing.subscription.upgrade.start

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
| `plan_not_found` | The `planSlug` doesn't match any row in `billing.plans` |
| `price_missing` | The plan has no Stripe price ID for the requested interval |
| `stripe_no_url` | Stripe returned a session without a URL — provider issue |

## SPEC references

- `docs/epics/foundations/spec.md` §6.13 billing
- Memory: [[no-drift-across-surfaces]] — present on api, mcp, agent
