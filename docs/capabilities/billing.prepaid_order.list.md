# list_prepaid_orders

**Capability:** `list_prepaid_orders`
**Domain:** billing
**Mode:** sync
**Scope:** org (the handler reads the org the caller's tenant scope names)
**Surfaces:** api, mcp
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`; reading your bill is never a governed action, ADR-052 exclusion 2, INV-27)

## Intent

What an enterprise paid for in advance, order by order (ADR-165): the licence period, the governed action units and the usage credits on each invoice, its status, when the units and the credits were granted, and the invoice's number and hosted page.

The list reads `billing.prepaid_orders`, LEFT JOINed to the webhook mirror `billing.invoices` on `stripe_invoice_id`. That column is unique in the mirror and an order records one invoice, so the join adds columns and never a row. An order still in `draft` has sent nothing and is not listed. Newest first by the order's creation time, keyset-paged on an opaque cursor.

The lines are rebuilt from the order's stored figures by the function that wrote them onto the invoice, so the list and the invoice print the same words.

The rev1 app does not render this list yet. The Billing page's invoices list (`list_invoices`) shows the same invoice with kind `subscription`, because no settlement names it.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `limit` | integer | no | 1 to 100, default 50 |
| `cursor` | string | no | the `nextCursor` of an earlier page; a cursor this capability did not write is `invalid_input` |

## Output

| Field | Type | Description |
|---|---|---|
| `items` | object[] | see the row below |
| `nextCursor` | string or null | null on the last page |

Each row:

| Field | Type | Description |
|---|---|---|
| `orderId` | string | uuid |
| `status` | enum | `open`, `paid`, `void`, `uncollectible` |
| `agreementRef` | string or null | printed in the invoice header |
| `poNumber` | string or null | printed in the invoice header |
| `currency` | string | ISO 4217, lower case |
| `lines` | object[] | `kind` (`licence`, `gau`, `credits`), `description`, `quantity`, `amountMicros`, `periodStart`, `periodEnd` |
| `totalMicros` | string | integer micro-units of `currency` |
| `grantOn` | enum | `paid` or `issue` |
| `unitsGrantedAt` | string or null | RFC 3339 |
| `creditsGrantedAt` | string or null | RFC 3339 |
| `paidAt` | string or null | RFC 3339 |
| `createdAt` | string | RFC 3339 |
| `invoice` | object or null | `number`, `status`, `dueAt`, `hostedInvoiceUrl`, `invoicePdfUrl`; null until the webhook mirrors the invoice |

## Roles

Org Owner, Admin, Billing, for the signed-in user or, on an API-key call, the key's creator (`resolveActingUserId`). The handler checks the role with `assertOrgRole`; the kernel's IAM check allows every capability for a non-enterprise org (INV-29).

## Side effects

None. Read-only; audit-exempt (the kernel's `capability.invoke_*` audit records the access).

## Surfaces

- `POST /v1/{org}/{ws}/billing/prepaid-orders`
- MCP tool `list_prepaid_orders`

## Errors

| code | meaning |
|---|---|
| `forbidden` (`HandlerError`, 403) | no signed-in user and no API key with a live creator, or the acting user holds none of Owner, Admin, Billing in the org |
| `invalid_input` | a cursor this capability did not write, or a `limit` outside 1 to 100 |
