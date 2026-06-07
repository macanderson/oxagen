# billing.credits.purchase

**Domain:** billing
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium (requires approval)

## Intent

Initiate a dynamic usage-credit purchase via Stripe Checkout. The customer specifies a face-value dollar amount; the applicable volume discount is applied automatically, so the customer pays less but receives the full face-value in credits (1 credit = 1¢). The credits are deposited by the Stripe webhook after payment completes — this capability does **not** grant credits itself. Returns the Checkout URL for the caller to open.

## Input

| Field | Type | Notes |
|---|---|---|
| `amountUsd` | `number` (≥ 5) | Face-value dollar amount of credits to purchase. Minimum $5. `amountUsd × 100` = credits granted. |
| `successUrl` | `string?` (URL) | Optional Stripe Checkout success redirect URL. Falls back to billing package default. |
| `cancelUrl` | `string?` (URL) | Optional Stripe Checkout cancel redirect URL. Falls back to billing package default. |

## Output

| Field | Type | Notes |
|---|---|---|
| `url` | `string` (URL) | Stripe Checkout URL to redirect the customer to. |
| `grantCents` | `number` (int) | Credits (in cents) the customer will receive after payment (`amountUsd × 100`). |
| `priceCents` | `number` (int) | Amount the customer will actually pay, in USD cents (after volume discount). |
| `percent` | `number` | Discount percentage applied (e.g. `15` = 15% off). `0` when no discount applies. |

## Roles

Org Owner, Billing.

## Side effects

- Stripe: creates a Checkout Session; no credits are granted until the webhook lands.
- ClickHouse: emits `tool_invocations` row on invocation.

## Surfaces

- `POST /api/v1/{org}/{ws}/billing/credits/purchase`
- MCP tool `billing_credits_purchase` (requires approval)
- Agent: requires approval, risk `medium`, category `billing`.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller is not an org Owner or Billing role. |
| `stripe_error` | Stripe Checkout session creation failed. |
| `validation_error` | Input failed Zod parse (e.g., `amountUsd < 5`). |
