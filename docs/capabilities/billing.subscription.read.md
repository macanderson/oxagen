# billing.subscription.read

**Domain:** billing
**Mode:** sync
**Scope:** tenant

## Intent

Return the active subscription, plan slug, current period bounds, and
credit balance for the caller's active tenant. Used by the billing
dashboard, the upgrade flow, and the runtime credit-gate when an agent
attempts a paid action.

## Input

Empty object. Tenant scope is resolved from the request context.

## Output

| Field                              | Type                              | Notes                                       |
| ---------------------------------- | --------------------------------- | ------------------------------------------- |
| `subscription`                     | object or `null`                  | `null` when the tenant has never subscribed. |
| `subscription.publicId`            | `string`                          | Prefixed subscription identifier.           |
| `subscription.status`              | `string`                          | Mirrors Stripe (`active`, `past_due`, …).   |
| `subscription.planSlug`            | `string`                          | Catalogue slug of the active plan.          |
| `subscription.billingInterval`     | `"month" \| "year"`               |                                             |
| `subscription.currentPeriodStart`  | `string` (ISO 8601)               |                                             |
| `subscription.currentPeriodEnd`    | `string` (ISO 8601)               |                                             |
| `subscription.cancelAtPeriodEnd`   | `boolean`                         |                                             |
| `subscription.seatCount`           | `number` (non-negative integer)   |                                             |
| `creditBalanceCents`               | `number` (integer)                | From `billing.credit_balances`.             |

## Side effects

- Postgres: read-only on `billing.subscriptions`, `billing.plans`, `billing.credit_balances`.
- ClickHouse: none.
- Neo4j: none.

## Errors

| code             | meaning                                  |
| ---------------- | ---------------------------------------- |
| `tenant_missing` | No active tenant on the request context. |
| `forbidden`      | Caller lacks `billing:read` on tenant.   |

## SPEC references

- §6.13 — `billing` schema
- §2.3 (6) — billing suite acceptance criteria
