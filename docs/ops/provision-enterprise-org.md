# Provisioning an organisation onto enterprise

Some organisations never go through Stripe checkout: Oxagen's own tenant, a
design partner on a signed agreement, an internal demo org. `pnpm
db:provision-enterprise` is the operator path for those — it puts an
organisation on the enterprise tier and holds its credit balance above a floor,
so neither the in-app agent's pre-turn gate nor the governed-action meter can
refuse work for want of funds.

**Nothing is bypassed.** No gate is disabled and there is no billing-exempt
flag. Every governed action is still metered, priced and written to the ledger
exactly as it is for a paying customer — read the ledger afterwards and you get
a true account of what the org spent. Only the funding changes.

## What can refuse a turn, and what the script does about it

`assertCanStartTurn` (`packages/billing/src/metering.ts`) has three affirmative
refusals, and the kernel's budget gate adds a fourth:

| Refusal | Cause | What the script does |
| --- | --- | --- |
| `BillingSuspendedError` | `dunning_state = 'suspended'` | resets to `active`, clears `delinquent_since` / `grace_ends_at` / `suspended_at` |
| `InsufficientCreditsError` | effective balance `<= 0` after auto-reload | tops up to `--floor-usd` (default $100,000) with a **non-expiring** lot |
| `AssistantSpendCapError` | month's platform-paid assistant spend reached `assistant_spend_cap_cents` (default **$20**, ADR-053 §3) | sets it to `NULL`, which the cap check reads as "no cap" |
| `BudgetExceededError` | an enabled `billing.spend_budgets` ceiling | disables the org's ceilings (rows kept, so the config is recoverable) |

It also sets `org.organizations.plan_type = 'enterprise'` and records the
governed-action commitment in `negotiated_actions_annual`.

## Usage

```bash
# Dry run — prints every change it would make, writes nothing.
pnpm db:provision-enterprise --email mac@oxagen.sh

# Apply.
pnpm db:provision-enterprise --email mac@oxagen.sh --apply

# A specific org, a larger commitment.
pnpm db:provision-enterprise --org acme --actions-annual 25000000 --apply
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--email` | — | every org the user belongs to |
| `--org` | — | one org by slug, uuid or `org_…` public id |
| `--floor-usd` | `100000` ($100,000) | the balance floor to hold |
| `--actions-annual` | `1500000` | the recorded governed-action commitment |
| `--apply` | off | write; without it the run is read-only |

**Every step is idempotent.** Re-running converges rather than accumulating: the
credit step grants only the shortfall below the floor, so running it a second
time right away is a no-op, and running it after the balance has been spent down
tops it back up. That makes this the maintenance command as well as the setup
one.

## Three things to know before you run it

**An entitled subscription outranks `plan_type`.** `resolveOrgTierDetailed`
reads the subscription leg first, so for an org with an entitled subscription on
a non-enterprise plan the tier write is inert. The script detects this, says so,
and exits 2 rather than printing green over a change that did not take. Move the
subscription to an enterprise plan in Stripe or cancel it, then re-run. The
credit floor still applies either way.


**Enterprise switches a security control ON.** It is the only tier whose orgs run
the full IAM resolver — `checkIAM` fast-paths every lower tier — so an org whose
IAM was never seeded would start denying by default. The script reports whether
the org has IAM principals; if it does not, run `pnpm db:backfill-iam -- --apply`
first. (The org's system-default Owner is a super-user under rule 7.5, so a
seeded org's owner cannot be locked out of a capability nobody seeded.)

**Why `plan_type` and not a subscription.** `resolveOrgTierDetailed` reads the
subscription first and `organizations.plan_type` second. The subscription leg
needs a real `stripe_subscription_id`; minting a synthetic one would put a row in
front of Stripe reconciliation that no Stripe object backs, and
`cancelOrgSubscription` / `startSubscriptionUpgrade` would then call Stripe with
an id it never issued. So the legacy leg is the correct one here — and
`negotiated_actions_annual` exists so that taking it does not cost the org its
recorded allowance.

## Running it against production

Aurora is VPC-only, so this runs from a laptop over an SSM port-forward, exactly
like the `billing.plans` half of `pnpm billing:stripe-sync` (see
[stripe-sandbox-mode.md](stripe-sandbox-mode.md) for the full recipe).

```bash
# 1. Authenticate to account 916294258235 (interactive).
aws login

# 2. Port-forward Aurora to localhost:15432.
aws ssm start-session \
  --target <bastion-instance-id> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["oxagen-postgres.cluster-cm1o4comkr8r.us-east-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["15432"]}'

# 3. In a second shell — note the explicit DATABASE_URL. `tsx --env-file` does
#    NOT override a shell-set one, so set it deliberately and read the host the
#    script prints back before answering the confirmation prompt.
cd ~/Projects/oxagen
DATABASE_URL='postgres://<user>:<pass>@localhost:15432/oxagen' \
  pnpm db:provision-enterprise --email mac@oxagen.sh          # dry run first
DATABASE_URL='postgres://<user>:<pass>@localhost:15432/oxagen' \
  pnpm db:provision-enterprise --email mac@oxagen.sh --apply  # then apply
```

The `--apply` run prompts for confirmation on any non-local host. The
credentials for step 3 are in Parameter Store under `/oxagen/production/`.

## Verifying afterwards

Don't trust the script's own output alone — query the database:

```sql
SELECT o.slug, o.plan_type, o.status, o.negotiated_actions_annual,
       s.assistant_spend_cap_cents, s.dunning_state,
       (SELECT coalesce(sum(remaining_cents), 0)
          FROM billing.credit_lots l
         WHERE l.org_id = o.id
           AND (l.expires_at IS NULL OR l.expires_at > now())) AS effective_balance_cents
  FROM org.organizations o
  LEFT JOIN billing.org_billing_settings s ON s.org_id = o.id
 WHERE o.slug = '<slug>';
```

Expect `plan_type = enterprise`, `assistant_spend_cap_cents` NULL,
`dunning_state = active`, and `effective_balance_cents` at the floor
(`10000000` for the default $100,000).
