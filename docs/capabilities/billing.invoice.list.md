# list_invoices

**Capability:** `list_invoices`
**Domain:** billing
**Mode:** sync
**Scope:** org (the handler reads the org the caller's tenant scope names)
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`; reading your bill is never a governed action, ADR-052 exclusion 2, INV-27)

## Intent

The Invoices section of the Billing page (`apps/app/ARCHITECTURE.md` §1.4, §3.9). Lists the organization's invoice headers from the webhook mirror `billing.invoices`, which `syncInvoiceFromStripe` keeps current from Stripe's `invoice.*` events. Each row carries a `kind`: the settlement ledger `billing.gau_settlements` names the Stripe Invoice behind every block purchase, auto top-up, interim and period-close charge, and an invoice no settlement names is the subscription's own. The handler LEFT JOINs the two on `stripe_invoice_id`.

Drafts are excluded. Newest first by the mirror row's creation time, keyset-paged on an opaque cursor.

An `open` interim invoice of an invoice-billed org with no saved payment method is listed with its `hostedInvoiceUrl`; that page is how the org pays it.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `limit` | integer | no | 1-100, default 50 |
| `cursor` | string | no | the `nextCursor` of an earlier page; a cursor this capability did not write is `invalid_input` |

## Output

| Field | Type | Description |
|---|---|---|
| `items` | object[] | see the row below |
| `nextCursor` | string or null | null on the last page |

Each row:

| Field | Type | Description |
|---|---|---|
| `publicId` | string | the `inv_…` public identifier |
| `number` | string or null | Stripe's invoice number; null when Stripe has not assigned one |
| `status` | enum | `open`, `paid`, `uncollectible`, `void` — Stripe's status as mirrored |
| `kind` | enum | `subscription`, `gau_purchase` (a `checkout` settlement), `gau_auto_topup` (`auto_topup`), `gau_interim` (`interim_invoice`), `gau_period_close` (`period_close`) |
| `amountDueMicros` | string | integer micro-units of `currency`, as a decimal string |
| `amountPaidMicros` | string | integer micro-units of `currency`, as a decimal string |
| `currency` | string | ISO 4217, lower case as Stripe reports it |
| `periodStart` | string | RFC 3339 |
| `periodEnd` | string | RFC 3339 |
| `hostedInvoiceUrl` | string or null | the Stripe-hosted invoice page; null until Stripe publishes one |

## Roles

Org Owner, Admin, Billing, for the signed-in user or, on an API-key call, the key's creator (`resolveActingUserId`). The handler checks the role with `assertOrgRole`; the kernel's IAM check allows every capability for a non-enterprise org (INV-29).

## Side effects

None. Read-only; audit-exempt (the kernel's `capability.invoke_*` audit records the access).

## Surfaces

- `POST /v1/{org}/{ws}/billing/invoices`
- MCP tool `list_invoices`

## Errors

| code | meaning |
|---|---|
| `forbidden` (`HandlerError`, 403) | no signed-in user and no API key with a live creator, or the acting user (the signed-in user, or the key's creator) holds none of Owner, Admin, Billing in the org |
| `invalid_input` | a cursor this capability did not write |
