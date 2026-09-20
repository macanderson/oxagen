# get_subscription

**Domain:** billing
**Mode:** sync
**Scope:** tenant

## Intent

Return the active subscription, plan slug, current period bounds, and
credit balance for the caller's active tenant. Used by the billing
dashboard and the upgrade flow.

Reading your bill is never a charge (ADR-052 exclusion 2, INV-27): the
contract declares `noBillingGate: true`, so a prepaid organisation whose
month bucket of governed action units is empty can still read the plan that
says so. The handler checks the caller's org role itself — Owner, Admin or
Billing — because the kernel's IAM check enforces `defaultRoles` for
enterprise organisations only (ARCHITECTURE.md §3.2, INV-29).

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
| `creditBalanceCents`               | `number` (integer)                | Sum of unexpired `billing.credit_lots` through `effectiveBalance`.             |

## Side effects

- Postgres: read-only on `billing.subscriptions`, `billing.plans`, `billing.credit_lots`.
- ClickHouse: none.
- Neo4j: none.

## Errors

| code             | meaning                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `tenant_missing` | No active tenant on the request context.                                                  |
| `forbidden`      | `HandlerError` (403): no signed-in user and no API key with a live creator (`no_principal`), or the acting user (the signed-in user, or the key's creator) holds none of Owner, Admin, Billing in the org (`org_role_required`). |

## SPEC references

- §6.13 — `billing` schema
- §2.3 (6) — billing suite acceptance criteria

The credit balance excludes expired lots. A failed balance read fails the request rather than substituting the cached mirror. See ADR-131.
