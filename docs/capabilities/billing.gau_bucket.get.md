# billing.gau_bucket.get

**Capability:** `get_gau_bucket`
**Domain:** billing
**Mode:** sync
**Scope:** org (the handler reads the org the caller's tenant scope names)
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`; reading your bill is never a governed action, ADR-052 exclusion 2, INV-27)

## Intent

The Billing mode, Governed action bucket and Auto top-up sections of the Billing page (`apps/app/ARCHITECTURE.md` §1.4, §3.9; ADR-055 §4–6). One month of governed action units for the organization: the billing mode, the month the bucket covers, the four counts the balance is made of, the balance, and the half of the picture the mode owns.

The month is `periodFor`: the anniversary-day slice of an entitled subscription's cycle, or the UTC calendar month for an organization with none. The counts are `readBucket`, which answers with a virtual bucket — `included` from the resolved terms, `carried` from the previous month by the rollover formula, `used` zero — when no row exists yet. The mode and the auto top-up preferences are `readOrgBillingSettings`, a plain `SELECT` that answers with the column defaults for an organization with no row.

Every read on this path is a `SELECT`. Opening the page does not create the month's bucket or the settings row, so the read cannot race the recorder's lazy create.

`remaining = included + purchased + carried − used` and is reported as stored. It is negative when the organization is overdrawn: the gate checks `remaining > 0` before a governed action and the recorder debits after it, so concurrent actions can drive `used` past the total.

No money crosses this wire. The contracted rate, the block price and the block size are `get_contract_rate`'s; the invoice amounts are `list_invoices`'.

## Input

None.

## Output

| Field | Type | Description |
|---|---|---|
| `mode` | enum | `prepaid` or `invoice` — `org_billing_settings.approved_for_invoice_billing` |
| `period.start` | string | RFC 3339, first instant of the month |
| `period.end` | string | RFC 3339, first instant after it |
| `includedGau` | integer | the terms' `included_gau_per_month` for this month |
| `purchasedGau` | integer | units bought this month (paid checkout and auto top-up settlements) |
| `carriedGau` | integer | units carried in from the previous month |
| `usedGau` | integer | governed actions recorded this month |
| `remainingGau` | integer | `included + purchased + carried − used`; negative when overdrawn |
| `invoice` | object or null | non-null exactly when `mode` is `invoice` |
| `autoTopup` | object or null | non-null exactly when `mode` is `prepaid` |

`invoice`:

| Field | Type | Description |
|---|---|---|
| `gauMax` | integer | `invoice_gau_max`: the accrued overage at which an interim invoice is cut |
| `uninvoicedGau` | integer | `max(0, used − included − purchased − carried) − overage_invoiced`, floored at zero |
| `invoicedThisPeriodGau` | integer | overage this month's interim and period-close settlements have claimed |
| `pastDue` | boolean | true while an `interim_invoice` or `period_close` settlement of this month is `open` — a finalized, unpaid invoice. The organization keeps running; rev1 suspends nobody for it |

`autoTopup`:

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | `auto_topup_enabled` |
| `blocks` | integer | blocks charged per top-up |
| `paymentMethod` | object or null | `{ brand, last4 }` of the org's default `billing.payment_methods` row; null when none is saved, and then auto top-up cannot run |
| `lastAttempt` | object or null | `{ at, status }` of the latest `auto_topup` settlement of this month that reached `paid`, `open` or `failed`. A `pending` claim has no outcome to print until the close job resumes it |

An organization an operator has not approved for invoice billing reports `invoice: null` whatever `org_billing_settings.invoice_gau_max` holds for it: the column is stored and inert in prepaid.

## Roles

Org Owner, Admin, Billing. The handler checks the role with `assertOrgRole`; the kernel's IAM check allows every capability for a non-enterprise org (INV-29).

## Side effects

None. Read-only; audit-exempt (the kernel's `capability.invoke_*` audit records the access).

## Surfaces

- `GET /v1/{org}/{ws}/billing/gau-bucket`
- MCP tool `get_gau_bucket`

## Errors

| code | meaning |
|---|---|
| `forbidden` (`HandlerError`, 403) | no signed-in user, or the user holds none of Owner, Admin, Billing in the org |
