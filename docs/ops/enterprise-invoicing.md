# Invoicing an enterprise customer

An enterprise pays in advance: its platform licence for a period, usage credits for the in-app assistant, and optionally governed action units (GAUs). This runbook takes one customer from a signed agreement to a paid invoice with the credits and units in its account. The decisions behind it are in ADR-165 and ADR-055.

Every command below runs against the database `DATABASE_URL` names, and each one prints the target host first. Check it before you answer anything. A shell-exported `DATABASE_URL` beats `.env.local`, so `unset DATABASE_URL` when the env file should choose.

## What the customer buys

| Line | Unit | What happens when it is paid |
| --- | --- | --- |
| Platform licence | one amount for a period | recorded on the order; nothing is granted |
| Usage credits | 1 credit = 1 cent | a credit lot that never expires, spent by in-app assistant turns the platform key pays for |
| Governed action units | per unit, at the contracted rate | added to the org's current month as purchased units, which carry into later months |

An order can carry any of the three lines, and needs at least one.

## 1. Record the contract terms

The terms price every governed action from their effective date: the agreement reference, the rate, the block size units are sold in, and the units included each month.

```bash
pnpm billing:contract-terms --org acme --agreement MSA-2026-014 \
  --rate-per-1000-usd 3.00 --block-size 10000 --included-per-month 250000 \
  --from 2026-10-01 --dry-run
```

The dry run prints the terms beside the agreement in force and writes nothing. Run it again without `--dry-run` to store them. The agreement they replace is closed at `--from`, and the org's current month keeps the included units it started with.

The script refuses a rate and block size whose block is not a whole number of cents (`rate × block size` must be a multiple of 10,000 micros). Change one of them. Re-running the same terms writes nothing.

## 2. Approve invoice billing, if the agreement says so

Skip this step for a customer that only prepays. Invoice billing lets the org keep working past its units and bills the overage after the month closes.

```bash
pnpm billing:terms --org acme --invoice-billing on --invoice-gau-max 250000
```

## 3. Check the assistant cap

Platform-paid assistant turns stop at the org's monthly cap: $20 unless an operator changed it, and the app has no control for it. A customer that prepays $5,000 of credits under a $20 cap is refused after $20 a month.

Decide the cap with the customer, then either pass it on the invoice in step 4 (it is applied when the credits are granted), or set it now:

```bash
pnpm billing:terms --org acme --assistant-cap-usd 6000   # $6,000 a month
pnpm billing:terms --org acme --assistant-cap-usd none   # no cap
```

`pnpm db:provision-enterprise` also removes the cap, for orgs provisioned that way.

## 4. Issue the prepaid invoice

Stripe emails the invoice to the customer's billing address, so the Stripe customer needs an email. Set the email, the postal address and any tax ID on the customer in the Stripe dashboard first. Without an email, Stripe refuses to send and the order waits in `draft`.

Dry-run first:

```bash
pnpm billing:prepaid-invoice --org acme --agreement MSA-2026-014 --po PO-7781 \
  --licence-usd 120000 --licence-from 2026-10-01 --licence-to 2027-10-01 \
  --gau 2000000 --credits-usd 5000 --assistant-cap-usd 6000 \
  --days-until-due 30 --dry-run
```

The dry run resolves the org's contract, validates the order, and prints its lines, its total, when it grants, and the assistant cap. It writes nothing and does not call Stripe. It warns when the credits exceed a cap the order leaves alone.

Read the lines back against the agreement:

```
Oxagen platform licence (agreement MSA-2026-014): 1 Oct 2026 to 30 Sep 2027   $120,000.00
Governed action units, prepaid: 2,000,000 GAU at $3.00 per 1,000               $6,000.00
Usage credits for the in-app assistant, prepaid: $5,000.00 (500,000 credits)    $5,000.00
```

Then run the same command without `--dry-run`.

- `--licence-to` is the first day after the licence. `2027-10-01` prints as "to 30 Sep 2027".
- `--agreement` defaults to the org's contract. The unit rate defaults to the contracted rate. `--gau-rate-per-1000-usd` overrides it, and is required for an org with no contract terms.
- `--grant-on issue` grants the credits and units as soon as the invoice is sent, for a customer you extend credit to. The default grants on payment.
- `--memo "<text>"` prints a note above the lines.

The run prints an order id before it calls Stripe. If the run fails, fix the cause and re-run the same command with `--order-id <id>`. The order resumes where it stopped and no second invoice is created. The same id with different lines is refused.

## What the customer receives

One Stripe invoice, emailed, due in `--days-until-due` days, payable by bank transfer or on its hosted page. The header prints the agreement and the PO number. Each line prints what it sells, and the licence line carries its service period. The footer points to statements: "Itemised usage: request a statement for any period from Billing → Statements."

In Oxagen, `list_prepaid_orders` (API and MCP, Owner, Admin or Billing) lists the customer's orders with their lines, status, grant times, and invoice number and link. The Billing page's invoice list shows the same invoice with the kind `subscription`, because no settlement names it.

## What happens on payment

Stripe sends `invoice.paid`. The webhook grants the order once, whatever the number of deliveries:

- the units go into the org's current month as purchased units;
- the credits become a `purchase` lot that never expires, under the ledger reason `grant_prepaid_invoice`;
- the cap passed with `--assistant-cap-usd`, if any, is set in the same transaction;
- the order is marked `paid`.

A credit debt the org ran up before paying is collected from the new credits first.

If the invoice is voided or marked uncollectible, the order records it. An order that granted at issue keeps its credits and units: nothing is reclaimed automatically, and the webhook logs an error naming what stays granted. Decide with the customer, and reclaim by hand if needed. An uncollectible invoice that is paid later is granted then.

## Top-ups

The customer can top up at any time:

- **Credits by card.** An Owner, Admin or Billing member buys credits on the Billing page (`purchase_credits`). They arrive when Checkout completes.
- **Another prepaid invoice.** For a transfer-paid top-up, issue a new order with step 4 and only the lines being topped up, for example `--credits-usd 2500`. Each order is its own invoice.

## Statements

A statement itemises what the org used over a week, month, quarter, year or custom period.

```bash
pnpm billing:statement --org acme --period month --anchor 2026-10-01 --format html --out ./acme-oct.html
pnpm billing:statement --org acme --period custom --from 2026-10-01T00:00:00Z --to 2026-11-01T00:00:00Z --format csv --out ./acme-oct.csv
```

The customer gets the same document from Billing → Statements (`export_billing_statement`).

## Check balances

The customer reads its units on the Billing page (`get_gau_bucket`) and its orders with `list_prepaid_orders`. As an operator, read the statement for the current period, or query the stores directly (read-only):

```sql
-- The order and its grants.
SELECT id, status, credit_cents, gau_quantity, units_granted_at, credits_granted_at, paid_at, stripe_invoice_id
FROM billing.prepaid_orders WHERE org_id = '<org uuid>' ORDER BY created_at DESC;

-- Spendable credits.
SELECT COALESCE(SUM(remaining_cents), 0) FROM billing.credit_lots
WHERE org_id = '<org uuid>' AND (expires_at IS NULL OR expires_at > now());

-- This month's units: included + purchased + carried - used.
SELECT period_start, included_gau, purchased_gau, carried_gau, used_gau
FROM billing.gau_buckets WHERE org_id = '<org uuid>' ORDER BY period_start DESC LIMIT 1;
```

## Stopping

Nothing here runs on its own. An order exists only when an operator issues one, and the webhook branch acts only on invoices whose metadata names a prepaid order. To stop, stop issuing. To stop a single unpaid invoice, void it in the Stripe dashboard. The order records the void.
