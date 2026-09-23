# get_billing_statement

**Capability:** `get_billing_statement`
**Domain:** billing
**Mode:** sync
**Scope:** org (the handler reads the org the caller's tenant scope names)
**Surfaces:** api, mcp, cli
**Mutates:** no
**Billing gate:** skipped (`noBillingGate: true`; reading your bill is never a governed action, ADR-052 exclusion 2, INV-27)

## Intent

The organization's billing statement for one period, as structured data (ADR-158). It is the document a finance team reconciles an invoice against. Every figure is read from a ledger, and the `reconciliation` list names each identity the figures satisfy and whether it held.

A period is one of:

- the UTC calendar `week` (Monday to Sunday), `month`, `quarter` or `year` that contains `anchor`;
- a `custom` range `[from, to)` strictly longer than 48 hours and at most 366 days.

A period that has not started is refused. A period that has not ended is answered with `provisional: true`, and its figures run to `generatedAt`.

The builder is `buildBillingStatement` in `packages/billing/src/statement-reads.ts`, which runs every read in one `withOrgDb` transaction (ADR-086). The arithmetic is `assembleBillingStatement` in `packages/billing/src/statements.ts`.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `period` | enum | yes | `week`, `month`, `quarter`, `year`, `custom` |
| `anchor` | string | for a calendar period | `YYYY-MM-DD`, a UTC date inside the period |
| `from` | string | for `custom` | RFC 3339, the first instant |
| `to` | string | for `custom` | RFC 3339, the first instant after the period |
| `top` | integer | no | 1-100, default 25: rows per breakdown before the rest fold into `other` |

## Output

| Field | Description |
|---|---|
| `reference` | `ST-<first 8 hex of the org id>-<start>-<last day>`. The same organization and period always give the same reference. |
| `generatedAt`, `provisional` | when the statement was built, and whether the period is still open |
| `org` | id, name, slug |
| `period` | kind, start, end (exclusive), last day, label (`Q3 2026`, `September 2026`, `Week of 14 Sep 2026`, `1 Sep 2026 to 9 Sep 2026`) |
| `terms` | the terms in force at the period's last instant (now, for a provisional statement): source, tier, agreement reference, currency, rate per governed action unit in micros, block size, included units per month |
| `agreements` | every negotiated agreement in force at some point in the period |
| `governedActions` | total units and ledger rows; by source (`kernel`, `tacho`, `external_tool`); by workspace, agent, operator, and capability or tool (top N with labels and raw ids, plus `other`); a daily series covering every UTC day the period touches |
| `buckets` | the month buckets overlapping the period: included, purchased, carried, used, overage invoiced, remaining, overage, units billed in the period, ledger units, and `matched`, `unitemised` or `mismatch` |
| `settlements` | block purchases, auto top-ups, interim and period-close charges created or paid in the period: quantity, rate, subtotal, charged amount, status, and the invoice behind each |
| `reversals` | refunds and disputes of GAU purchases recorded in the period |
| `prepaidOrders` | non-draft prepaid orders created or paid in the period: licence, units, usage credits, total, invoice |
| `invoices`, `invoiceTotals` | non-draft invoices created or paid in the period, with what each charged for, and totals by currency (void invoices listed, left out of totals) |
| `usageCredits` | opening balance, additions and deductions by reason, closing balance, the assistant's model tokens, and the assistant's deductions by operator |
| `modelUsage` | model calls and tokens from `cost.daily_totals`, the vendor's list cost, and `billedMicros: "0"` |
| `reconciliation` | `{ id, statement, holds }` for `units_by_day`, `units_by_dimension`, `units_by_bucket`, `bucket_ledger`, `credits_roll_forward` |

Money is integer micro-units as a decimal string with an ISO 4217 currency (INV-09). Usage credits are whole credits as a decimal string, one credit to the cent.

## How the figures reconcile

- Governed action units come from `billing.gau_ledger`, selected on `billed_at`, the instant the units were added to a month bucket. That is the instant the invoices count, so a statement and the invoices for one period count the same units.
- The total equals the sum by source, the daily series, each breakdown including its `other`, and the units the overlapping buckets received in the period.
- A bucket's `used_gau` moves only through `debitWithLedger`, which adds exactly the units of the ledger rows it inserts in one transaction. A bucket created before the ledger reads `unitemised` by the units counted before it. `mismatch` fails `bucket_ledger`.
- The closing credit balance is read, not derived. `credits_roll_forward` checks it against the opening balance plus additions minus deductions. Credits that expire unused leave no ledger entry, so the Billing page's effective balance can be lower than the ledger balance.

## Roles

Org Owner, Admin, Billing, for the signed-in user or, on an API-key call, the key's creator (`resolveActingUserId`). The handler checks the role with `assertOrgRole` (INV-29).

## Side effects

None. Read-only; audit-exempt (the kernel's `capability.invoke_*` audit records the access).

## Surfaces

- `POST /v1/{org}/{ws}/billing/statement`
- MCP tool `get_billing_statement`
- CLI `oxagen billing statement --period <p> [--anchor <date> | --from <t> --to <t>] [--json]`

## Errors

| code | meaning |
|---|---|
| `forbidden` (`HandlerError`, 403) | the acting user holds none of Owner, Admin, Billing in the org |
| `invalid_input` | the period breaks a rule; the message opens with it: `anchor_required`, `anchor_invalid`, `range_required`, `range_invalid`, `range_too_short`, `range_too_long`, `period_not_started`, `unexpected_field` |
