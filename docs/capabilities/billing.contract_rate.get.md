# billing.contract_rate.get

**Domain:** billing
**Mode:** sync
**Scope:** tenant

## Intent

Return the organisation's contracted governed-action terms: the per-GAU
rate, the block size, the currency, the GAUs included each month, the
effective dates, and where the figures come from. The billing page's "Your
contracted rate" block reads it, and the purchase form prices a block from
`ratePerGauMicros × blockSizeGau`.

There is one source of truth per customer (ADR-055 §3). The handler calls
`resolveContractTerms`, which answers with the effective
`billing.contract_terms` row when the organisation has one, and otherwise
with the published figures on the `billing.plans` row of its entitled
subscription, or the Free plan's for an organisation with no entitled
subscription. Nothing copies a tier into the organisation, so a plan change
is reflected on the next read. `ACTION_RATE_BANDS`, the retired dollar
model's global band table, prices nothing here.

Reading your rate is never a charge (ADR-052 exclusion 2, INV-27): the
contract declares `noBillingGate: true`, so an organisation whose month
bucket of governed action units is empty can still read what a top-up costs.
The handler checks the caller's org role itself — Owner, Admin or Billing —
because the kernel's IAM check enforces `defaultRoles` for enterprise
organisations only (ARCHITECTURE.md §3.2, INV-29).

## Input

Empty object. Tenant scope is resolved from the request context.

## Output

| Field                 | Type                                            | Notes                                                                       |
| --------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| `source`              | `"published_tier" \| "negotiated"`               | Which table answered.                                                        |
| `agreementRef`        | `string` or `null`                               | The negotiated row's agreement reference; `null` for a published tier.        |
| `tier`                | `"free" \| "build" \| "scale" \| "enterprise"`   | The entitlement's tier; a negotiated row carries none of its own.             |
| `currency`            | `string` (ISO 4217, lower case)                  | As `billing.plans.currency` stores it.                                        |
| `ratePerGauMicros`    | `string` (decimal digits)                        | Micro-dollars per GAU (1 cent = 10,000 micros), as a decimal string.          |
| `blockSizeGau`        | `number` (positive integer)                      | GAUs per purchased block. The one place this figure is printed.               |
| `includedGauPerMonth` | `number` (non-negative integer)                  | GAUs included in every month of a subscription.                               |
| `effectiveFrom`       | `string` (ISO 8601)                              | The agreement's start; for a published tier, when the plan row was written.    |
| `effectiveTo`         | `string` (ISO 8601) or `null`                    | The agreement's end; `null` while it is open-ended, and always for a tier.     |

## Side effects

- Postgres: read-only on `billing.contract_terms`, `billing.subscriptions`, `billing.plans`, and `auth.api_keys` (an API key's creator), `iam.principals` / `iam.principal_role_assignments` / `iam.roles` for the role gate.
- ClickHouse: none.
- Neo4j: none.

## Errors

| code             | meaning                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant_missing` | No active tenant on the request context.                                                                                                    |
| `forbidden`      | `HandlerError` (403): no signed-in user and no API key with a live creator (`no_principal`), or the acting user (the signed-in user, or the key's creator) holds none of Owner, Admin, Billing in the org (`org_role_required`).  |

A database with no seeded Free plan row has no published terms to fall back
to; the resolver throws rather than quoting a rate nobody published.

## SPEC references

- ADR-055 §2, §3 — published terms on the plan, negotiated terms per organisation, resolved at read time
- `docs/specs/governed-action-metering.md` §4.1, §4.2 — the v1 rates and allowances
- `apps/app/ARCHITECTURE.md` §1.4, §3.9 — what the billing page shows and the contract's shape
