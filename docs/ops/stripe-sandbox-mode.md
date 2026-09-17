# Stripe: every environment binds to the sandbox until the production cutover

**Status (2026-09-13):** production, CI and local development all run Stripe in
**test mode** against one shared sandbox. No environment holds a live
(`sk_live_` / `pk_live_`) key. The maintainer will switch production to live
keys as a deliberate, separate step; until then a `LIVE` banner from
`pnpm billing:stripe-sync` means the wrong key is in scope.

This note records **where** the key set lives and **how** to rotate it. It
holds no secret values — only names, prefixes and resource ids.

## The sandbox

| Item | Value |
| --- | --- |
| Stripe account | `acct_1Ty2gjK5L8c4uZ0j` ("New business sandbox", test mode) |
| Key set on the maintainer's machine | `~/.env.stripe-sandbox.local` (`STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_PUBLIC_KEY`) — source it in a script, never `cat` it |
| Catalog | 6 products / 9 prices created by `pnpm billing:stripe-sync --apply` from `packages/billing/src/pricing.ts` (`build-v2`, `scale-v2`, `enterprise-v2`, `credits-{starter,power,scale}-v2`) |
| Webhook endpoint (production API) | `https://api.oxagen.sh/webhooks/stripe`, API version `2025-02-24.acacia`, the 20 events `stripeEventType()` in `packages/billing/src/stripe-provider.ts` maps |
| Staging / preview endpoint | none — the infra exposes no staging API host (`infra/tools/caddy/Caddyfile` serves only the five production hostnames). Local development uses `stripe listen` via `tools/scripts/stripe-tunnel.ts`, which mints its own per-session secret. |

The previous key set belonged to the Oxagen Inc. Stripe account
(`acct_1TCS8FBqX8HwIjwR`, test mode). Its `api.oxagen.sh` webhook endpoint
(`we_1TlwFyBqX8HwIjwRRbG4fvQn`) was disabled on 2026-09-13 so it stops posting
events the API can no longer verify. Rows in `billing.subscriptions`,
`billing.customers` and `billing.payment_methods` that reference that account's
objects will not resolve in the sandbox — acceptable in the zero-customer
period, and the reason a customer-facing cutover must re-sync `billing.plans`
(§ below).

## Where each variable lives

| Variable | Parameter Store (`/oxagen/production/…`, account `916294258235`, `us-east-1`) | GitHub Actions secret (`macanderson/oxagen`) | Local `.env.local` (root, `apps/app`, `apps/api`, `apps/mcp`) | Consumer |
| --- | --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | `SecureString` | repo + `production` environment (read by `stripe-sync.yml`) | yes | `api`, `app` at runtime |
| `STRIPE_PUBLISHABLE_KEY` | `SecureString` | repo + `production` (unused by workflows) | yes | provisioning only |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `SecureString` | repo + `production` (unused by workflows) | yes | **inlined into `apps/app` at `next build`** |
| `STRIPE_WEBHOOK_SECRET` | `SecureString` | repo + `production` (unused by workflows) | yes (dashboard value; `pnpm dev` overrides per session) | `api` `/webhooks/stripe` |

The old account (`578673726240`) still carries the same four names under
`/oxagen/production/` and is kept mirrored until it is decommissioned
(`infra/docs/new-account-migration-plan.md`); nothing deploys from it.

`pipeline.yml` and `nightly.yml` set literal `sk_test_ci` / `pk_test_ci` /
`whsec_test_ci` for unit tests. Those are placeholders, not secrets — leave
them.

## How the running services pick up a change

The node reads `/oxagen/production/` at container start
(`infra/tools/node/README.md`, `config_prefix`), so a server-side rotation is a
parameter write plus a restart. There is no restart-only GitHub workflow;
`deploy-node` in `pipeline.yml` runs only on a push to `main`. The restart path
is the SSM document `oxagen-deploy-service`, which re-downloads the current
artifact, re-reads Parameter Store and restarts the container (auto-rolling
back on a failed health check).

`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is compiled into the `app` bundle, so the
browser-side key changes only after a merge to `main` rebuilds `app`.

## Rotation recipe

Run as the maintainer with the account-`916294258235` login session
(`aws login`; unset the shell's static keys for the old account with
`env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN aws …`).
Values go through a `0600` `--cli-input-json` file, never argv; only prefixes
are ever printed.

```bash
set -a; . ~/.env.stripe-sandbox.local; set +a

# 1. Webhook endpoint — the secret is returned once, at creation. Keep it in a variable.
WHSEC=$(curl -sS https://api.stripe.com/v1/webhook_endpoints -u "$STRIPE_TEST_SECRET_KEY:" \
  -d url=https://api.oxagen.sh/webhooks/stripe -d api_version=2025-02-24.acacia \
  $(for e in customer.subscription.created customer.subscription.updated \
      customer.subscription.deleted customer.subscription.trial_will_end \
      invoice.created invoice.paid invoice.payment_failed invoice.payment_action_required \
      invoice.finalized invoice.voided invoice.marked_uncollectible \
      checkout.session.completed payment_method.attached payment_method.detached \
      payment_method.updated payment_method.automatically_updated \
      charge.dispute.created charge.dispute.closed charge.refunded; do \
      printf ' -d enabled_events[]=%s' "$e"; done) | jq -r .secret)

# 2. Parameter Store (repeat for each name/value pair).
put() { t=$(mktemp); chmod 600 "$t"
  jq -n --arg n "/oxagen/production/$1" --arg v "$2" '{Name:$n,Type:"SecureString",Overwrite:true,Value:$v}' > "$t"
  aws ssm put-parameter --region us-east-1 --cli-input-json "file://$t"; rm -f "$t"; }
put STRIPE_SECRET_KEY "$STRIPE_TEST_SECRET_KEY"
put STRIPE_PUBLISHABLE_KEY "$STRIPE_TEST_PUBLIC_KEY"
put NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY "$STRIPE_TEST_PUBLIC_KEY"
put STRIPE_WEBHOOK_SECRET "$WHSEC"

# 3. GitHub Actions (values over stdin).
for n in STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET; do
  printf %s "${!n}" | gh secret set "$n" --repo macanderson/oxagen
  printf %s "${!n}" | gh secret set "$n" --repo macanderson/oxagen --env production
done   # (bind the four names to the right variables first)

# 4. Restart the server-side consumers: api, then app, then mcp.
INSTANCE=$(aws ec2 describe-instances --region us-east-1 \
  --filters Name=tag:Name,Values=oxagen-app Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceId' --output text)
for svc in api app mcp; do
  aws ssm send-command --region us-east-1 --instance-ids "$INSTANCE" \
    --document-name oxagen-deploy-service --parameters "service=$svc"
done   # poll: aws ssm get-command-invocation --command-id … --instance-id "$INSTANCE" --query Status

# 5. Merge anything to main so `app` rebuilds with the new NEXT_PUBLIC_ key.
```

## Verify

- `aws ssm get-parameter --name /oxagen/production/STRIPE_SECRET_KEY --with-decryption --query Parameter.Value --output text | cut -c1-8` → `sk_test_`; compare `sha256` against the file value in a script.
- `curl -sS -X POST https://api.oxagen.sh/webhooks/stripe -o /dev/null -w '%{http_code}'` → `400` (missing signature) proves the route is up.
- Attach a test payment method to a throwaway sandbox customer (`payment_method.attached` is a handled event) and look for `"stripe webhook processed"` with that event id in the `/oxagen-app/api` log group; delete the customer afterwards.
- `gh workflow run stripe-sync.yml -f apply=false -f skip_db=true` → the log says `Targeting a TEST Stripe account.` and every product reports `reuse`.
- `pnpm billing:stripe-sync` locally → banner `test`, all `reuse`.

## Left for the cutover (maintainer)

- Decide the go-live date; then follow `docs/ops/stripe-product-sync-sop.md` §5 with live keys.
- ~~`billing.plans` in production Aurora still points at the previous account's
  `prod_`/`price_` ids.~~ **Done 2026-09-16.** The table was in fact *empty* —
  no row had ever been written to it — so nothing in production resolved a
  plan and no subscription could be purchased. Filled by running the upsert
  half of `pnpm billing:stripe-sync --apply` with `DATABASE_URL` pointed at
  production over an SSM port-forward. `stripe-sync.yml` has no `DATABASE_URL`
  and Aurora is VPC-only, so that is the only path; it stays a manual step:

  ```bash
  aws ssm start-session --region us-east-1 --target <oxagen-app instance> \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters '{"host":["oxagen-postgres.cluster-cm1o4comkr8r.us-east-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["15432"]}' &
  export DATABASE_URL=$(aws ssm get-parameter --region us-east-1 \
    --name /oxagen/production/DATABASE_URL --with-decryption \
    --query Parameter.Value --output text | sed -E 's#@[^/:]+:[0-9]+/#@localhost:15432/#')
  # Host and database only. `${DATABASE_URL%%@*}` would print everything BEFORE
  # the `@` — scheme, user and the decrypted production password — into the
  # terminal and any captured session log. CLAUDE.md asks which database you are
  # about to mutate, and that is the part after the `@`.
  echo "TARGET: …@${DATABASE_URL#*@}"
  pnpm billing:stripe-sync --apply
  ```

  Verify: `SELECT slug, monthly_cents, stripe_product_id, stripe_price_id_monthly
  FROM billing.plans ORDER BY monthly_cents;` — three rows (`build-v2` $199,
  `scale-v2` $999, `enterprise-v2` $500), every price id `active` in the
  sandbox. The `free` row `seedPlatform` writes is still absent in production;
  nothing reads it (a free org has no subscription row and the tier resolves to
  `free` by absence), and `upsertPlans` would tombstone it on the next sync, so
  it is left alone.
- Install the Stripe CLI locally (`brew install stripe/stripe-cli/stripe && stripe login`, choosing the sandbox) so `pnpm dev`'s `stripe listen` tunnel forwards sandbox events.
