# ADR-241: A new organization gets one grant of governed actions, then subscribes

- **Status:** Accepted
- **Date:** 2026-10-01
- **Owners:** platform
- **Amends:** ADR-055 §4 (the bucket's period), §6 (prepaid blocks and auto
  top-up on the governed-action path), §7 (who is billed for overage) and §13
  (what `create_org` writes).
- **Issues:** #4886 (this decision), #3844 (the Billing page prints the
  grant), #3858 (the governed-action half of prepaid blocks and auto top-up).
- **Related:** [docs/specs/governed-action-metering.md](../specs/governed-action-metering.md)
  §4.2, `packages/billing/src/signup-grant.ts`,
  `packages/billing/src/gau-bucket.ts` (`bucketBasis`, `assertGauAvailable`),
  `packages/billing/src/action-metering.ts`,
  `packages/billing/src/gau-settlements.ts` (the close job).

## Context

ADR-055 gave the Free tier 5,000 governed actions every month. A Free
organization that saved a card became prepaid and bought 5,000-action blocks
by auto top-up at list, which made it a usage-only customer. Paid tiers past
their allowance also bought blocks by auto top-up, and only an organization
approved for invoice billing was invoiced for overage.

Mac set a different model on 2026-10-01 (#4886):

- A new account gets one bucket of governed actions, granted once and never
  renewed, that expires 30 days after the account is created.
- The bucket covers two days of monitoring one person's agent runs at the
  volume Mac's machine produces. Mac's Claude Code and Codex transcripts for
  September 2026, deduplicated by tool-call id, held 33,028 tool calls per two
  days. The grant is 33,000 governed actions.
- Signing up never asks for a card. When the grant is used up or expires, the
  account adds a card and buys a subscription to keep governing.
- There are no usage-only customers. A saved card alone unlocks nothing.
- Billing is hybrid: a fixed subscription invoice, plus usage for governed
  actions past the plan's allowance.
- Every figure and rule above lives in data, so an operator changes it with
  no deploy.

## Decision

### 1. The grant is one row per organization

`billing.gau_signup_grants` holds an organization's grant: `granted_gau`,
`granted_at` and `expires_at`. A unique index on `org_id` makes it once-only.
`issueSignupGrant` inserts with `ON CONFLICT (org_id) DO NOTHING` and returns
null when a grant already exists, so no code path can grant twice.

`create_org` issues the grant on its bootstrap transaction, dated from the
organization's creation, beside the ADR-053 signup credits. The deprecated
app's onboarding path (`grantFreeCredits`) issues it the same way until
cutover. An organization therefore never exists without its grant.

### 2. The figures live on the Free plan row

The Free row of `billing.plans` carries three columns:

| Column | Launch value | Read |
|---|---|---|
| `signup_grant_gau` | 33,000 | at signup, copied into the grant |
| `signup_grant_days` | 30 | at signup, to set `expires_at` |
| `subscription_required_after_grant` | `true` | on every gate check |

The seed never writes these columns, so an operator's `UPDATE` on the Free
row survives the next deploy and reaches the next signup at once. A grant
already made keeps the figures it was made with. The other figures the
decision names already live in data: each plan's allowance is
`included_gau_per_month`, the overage rate is `rate_per_gau_micros`, both on
`billing.plans` or a negotiated `billing.contract_terms` row, and the interim
threshold is `org_billing_settings.invoice_gau_max`.

### 3. The grant is a bucket

ADR-055 §4 gave an organization with no subscription the UTC calendar month.
`bucketBasis` replaces that rule, and every reader and writer of the bucket
takes its period from it:

- **Subscription.** An entitled subscription's month, as ADR-055 §4 sets it,
  with the plan's or the agreement's monthly allowance.
- **Signup grant.** No subscription, inside the grant's window. The bucket's
  period is exactly `[granted_at, expires_at)` and its included units are
  `granted_gau`. The recorder, the ledger and `get_gau_bucket` read the grant
  through the one bucket writer, `ensureCurrentBucket`.
- **After the grant.** No subscription, and the grant has expired or never
  existed. The UTC calendar month, starting no earlier than the grant's
  expiry so the two buckets never overlap. Its allowance is zero while the
  Free row requires a subscription. When an operator clears
  `subscription_required_after_grant`, it is the Free row's
  `included_gau_per_month`, which keeps its value of 5,000 for that case.

A subscription supersedes the grant. An organization that subscribes during
its grant's window moves to the subscription's month and allowance, and the
grant's unused units do not carry.

### 4. The gate refuses an organization with no subscription after its grant

`assertGauAvailable`, in order:

1. `BillingSuspendedError` when dunning has suspended the organization.
2. Admit an organization approved for invoice billing.
3. Admit an organization with an entitled subscription, at any balance. Its
   actions past the allowance are billed as overage (§5).
4. Inside the grant's window, admit while the grant has units left. Refuse
   with `signup_grant_used` once it has none.
5. After the grant, or with none, refuse with `signup_grant_expired` or
   `no_signup_grant` while the Free row requires a subscription. With the
   rule cleared, admit on the monthly allowance and refuse past it with
   `monthly_allowance_used`.

Each refusal is `gau_exhausted` (402 at the API) with its reason, and its
message says to add a card and choose a plan. The gate no longer reads the
saved card: a card with no subscription leaves every refusal in place. The
reason `free_no_payment_method` is retired.

### 5. Every subscriber is billed for overage, and auto top-up leaves the path

The recorder no longer claims auto top-up. The interim invoice threshold of
ADR-055 §7 (`invoice_gau_max`) and the close job's period-close invoice now
run for every subscriber, not only for an organization approved for invoice
billing. Each is a Stripe invoice at the rate on the plan row or the
agreement, charged to the saved card, or emailed when there is none.

The decision asks for overage on the subscription invoice through Stripe
metered usage. This ADR does not build that step. A Stripe metered price
holds its own unit amount in the Stripe catalogue, which is a second copy of
the overage rate that the decision says lives in data. Moving the overage
onto the subscription invoice needs a choice between a metered price that
`billing:stripe-sync` keeps equal to the plan row, and a pending invoice item
priced from the plan row that Stripe adds to the next subscription invoice.
Either needs a Stripe test account to prove where the line lands and when.
#4886 keeps that item open.

ADR-055 §7's suspension 5 days after an overage invoice is past due is not
built yet (ADR-055 calls it WL-60). Subscription dunning still suspends an
organization whose subscription invoice fails. #4886 keeps the overage
suspension open too.

### 6. Existing organizations

An organization created before this decision has no grant row. The
migration that adds `billing.gau_signup_grants` gives each existing
organization a grant from the deploy date: `granted_gau` from the Free row,
`granted_at` the deploy instant, and `expires_at` 30 days later. The
migration's header says so.

## Alternatives

- **A grant derived from `organizations.created_at`.** No new table, but an
  existing organization would get a grant that expired long ago, and the
  decision gives each one a grant from the deploy date. The table records
  the grant each organization actually received.
- **A separate singleton table for the grant figures.** The Free row already
  carries the Free tier's published terms and is read on every gate check,
  so the three columns cost no extra query.
- **Keep auto top-up for subscribers past the allowance.** A prepaid block
  past the allowance is a second overage path beside the invoice, which is
  what the decision removes.

## Consequences

- A new organization governs for 30 days or 33,000 actions with no card,
  then subscribes.
- An operator changes the grant size, its lifetime, or the subscription rule
  with one `UPDATE` on the Free row.
- `purchase_gau_bucket`, `set_auto_topup`, their UI, and the pay journey's
  block purchase still exist. Taking them off the app, the API, MCP and the
  CLI, and moving `pay.spec.ts` onto the subscribe path, remain open on #4886
  and #3858. The recorder no longer charges auto top-up, so the setting has
  no effect on governed actions.
- An overage invoice is a separate invoice from the subscription's until the
  metered-usage step in §5 lands.
- An organization with a negotiated `billing.contract_terms` row, no
  subscription, and no invoice-billing approval is refused once its grant
  ends, like any organization with no subscription. An operator approves it
  for invoice billing, or gives it a subscription, before this change
  deploys.
