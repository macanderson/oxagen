# oxagen-aws-infra

Infrastructure for three brands — **Oxagen**, **Stella**, and the **Context
Graph Protocol** — kept separate by tagging, Resource Groups, and per-brand
Terraform state rather than by separate AWS accounts.

**This directory holds two generations of that infrastructure.** `stacks/`
is the original layout, still Terraform for the old account (`578673726240`)
and left as-is — the rest of this README describes it. `stacks-new/` is the
live platform today, in the new account (`916294258235`), the target of the
2026-08-27 cutover; see `docs/new-account-migration-plan.md` for how it
differs and what has and hasn't been decommissioned in the old account.
Everything under **"Applying from CI"** below is about `stacks-new/`.

Managed with [OpenTofu](https://opentofu.org). `stacks/`'s state lives in
`s3://oxagen-tfstate-578673726240` with locking in the `oxagen-tflock`
DynamoDB table, both of which predate this repository.

## Isolated staging

`infra/stacks-new/staging` owns the staging VPC, Aurora database, app node,
artifact bucket, and `/oxagen/staging` configuration. It uses the
`infra/modules/isolated-environment` module. Its state key is
`environments/staging/terraform.tfstate`. Applying this stack does not apply
`stacks-new/oxagen` or `stacks-new/ci-deploy`.

```bash
tofu -chdir=infra/stacks-new/staging init
tofu -chdir=infra/stacks-new/staging plan -out=staging.plan
tofu -chdir=infra/stacks-new/staging apply staging.plan
```

Inspect the account and plan before applying. The configured account is
`916294258235`. The staging instance is `oxagen-staging-app`, and the Postgres
cluster is `oxagen-staging-postgres`. Its database is `oxagen`. A first plan
creates resources. A later plan should describe only the intended change.

The Staging workflow migrates these stores, builds each service with staging
browser URLs, deploys it through `oxagen-staging-deploy-service`, and probes
its public endpoints. It records the source commit and artifact versions in
`s3://oxagen-staging-deploy-916294258235/_deploy/release.json`. Read that record
alongside the workflow run when establishing which release was exercised.
A successful HTTP response alone does not establish a release identity.

Staging generates its own database, auth, encryption, and engine credentials.
It has no production records. The staging setup reuses a verified Stripe sandbox key with its own webhook
signing secret. Model calls use an authorized shared Gateway key and write
usage to the staging stores. OAuth is disabled through a preview-only build
option. Inngest runs its own pinned development server on the staging node,
following the [Inngest Docker guidance](https://www.inngest.com/docs/local-development).
These provider choices are specific to staging. Supply separate provider
credentials for a customer deployment. The build registry still reports
missing database, billing, or model credentials before building.

## Customer account deployment

This is an Oxagen-operated deployment into a customer-owned AWS account.
The module and runbook have not been exercised in a second account. The
available account has no AWS Organizations membership, so no second account
was available to validate that claim.

1. Obtain an IAM role in the customer's account and confirm its account ID
   with `aws sts get-caller-identity`. Select a region and three availability
   zones with the pinned ARM Amazon Linux AMI available.
2. Bootstrap an encrypted, versioned Terraform state bucket and lock table
   in that account. Use `infra/stacks-new/bootstrap` as the reference. Keep
   the customer's state and credentials separate from the hosted platform.
3. Create a root stack that calls `infra/modules/isolated-environment`.
   Supply the account ID, region, three availability zones, pinned AMI,
   unused VPC CIDR, environment slug such as `customer-prod`, DNS suffix,
   hosted zone ID, GitHub OIDC provider ARN, and exact OIDC subjects for the
   repository and GitHub environment that will deploy it. Use
   `infra/stacks-new/staging` as the root-stack example. Configure its S3
   backend with the customer's state bucket and a distinct state key.
4. Apply the plan and retain its outputs. Adapt the Staging workflow to the
   output node name, deploy bucket, deploy role, deploy document, parameter
   prefix, and service hostnames. Its hardcoded staging database check must
   name the new cluster before migrations can run.
5. Supply the customer's provider credentials through their Parameter Store
   prefix. The required build keys come from `packages/config/src/registry.ts`.
   The customer supplies OAuth applications, Stripe sandbox or billing
   credentials, Inngest configuration, and model credentials as applicable.
6. Run the migrations and deployment in that account. Verify the public
   endpoints, the source commit, and artifact versions. Exercise the three
   browser flows against the new environment before handing it over.

AWS holds the stores, encrypted configuration, and deployment artifacts in
that account. Model requests still reach the configured model providers or
AI Gateway. Inngest, Stripe, OAuth providers, and any configured connector
remain external subprocessors. Selecting a customer account does not make
those services local. An Oxagen operator with the supplied AWS role can
access whatever that role permits, including application records and
secrets. Revoke or narrow the role to change that access.

## Why one account

Separate AWS accounts under an Organization isolate harder. They also need a
payer account, cross-account roles, and per-account bootstrapping — real
operational weight for a migration whose stated constraint is to cost as little
as possible. The separation here is carried by three mechanisms that cost
nothing:

1. A `Brand` tag on every resource, applied through each stack's provider
   `default_tags` so a new resource cannot miss it.
2. A Resource Group per brand, which turns that tag into a browsable collection
   in the console.
3. A separate state key per brand, so one brand's apply cannot see or modify
   another's resources.

Cost allocation is the fourth mechanism and the only one Terraform cannot
create: `Brand` must be activated as a cost allocation tag in the Billing
console before Cost Explorer will group by it.

## Layout

```
modules/
  brand-group/   Resource Group + brand identity
  static-site/   S3 + CloudFront for a site that is entirely files
  nextjs-site/   S3 + Lambda + CloudFront for a site that runs code
  redirect-site/ CloudFront Function that sends a retired domain elsewhere
  data-node/     Postgres + Neo4j + ClickHouse on one instance
stacks/
  oxagen/        oxagen.sh zone, marketing site, docs site, oxagen.ai redirect
  oxagen-data/   the data plane (separate state; see below)
  stella/        stella.oxagen.sh
  cgp/           contextgraphprotocol.org
tools/
  import-dns.py      Vercel DNS export -> Route 53 record set
  deploy-static.sh   upload a built site and invalidate its CDN
  package-nextjs.sh  OpenNext build -> deployable Lambda zip
  migrate-secrets.py .env files -> SSM Parameter Store, classified
```

`oxagen-data` is split from `oxagen` deliberately. The brand is the unit of
*grouping*; the state file is the unit of *blast radius*. A website deploy runs
often; a database apply can destroy data. Sharing state between them means
every routine site deploy computes a plan containing the database.

## Apply order

`oxagen` first — it creates the `oxagen.sh` zone whose id the `stella` stack
takes as `parent_zone_id`. Everything else is independent.

```bash
cd stacks/oxagen      && tofu init && tofu apply
cd stacks/cgp         && tofu init && tofu apply
cd stacks/stella      && tofu init && tofu apply   # needs parent_zone_id
cd stacks/oxagen-data && tofu init && tofu apply
cd stacks/ci-deploy   && tofu init && tofu apply   # who may deploy, and to what
```

## Do not apply `oxagen` or `stella` untargeted

**A plain `tofu apply` in `stacks/oxagen` takes `docs.oxagen.sh` down**, and the
same trap is set in `stacks/stella` for `stella.oxagen.sh`. Check the plan
before every apply in either.

Both sites are built by the `nextjs-site` module, which creates an alias record
pointing at a CloudFront distribution in front of a Lambda. That front door
returns 403 for every request in this account (see "Serving from the node"
below), so during the migration both records were repointed by hand at the
instance's Elastic IP. Terraform still holds the alias in state and still wants
it back:

```text
# module.docs.aws_route53_record.ipv4["docs.oxagen.sh"] will be updated in-place
  ~ records = [ - "52.0.98.83" ]
```

Applying that reverts a working site to a 403. Until the module stops creating
records for a node-served site, apply those two stacks with `-target`:

```bash
tofu -chdir=stacks/oxagen apply -target='aws_route53_record.node_service'
```

The three records in `stacks/oxagen/node-services.tf` — `app`, `api` and `mcp`
— are unaffected: they are plain `A` records this repository owns outright, and
nothing else proposes changes to them.

## `oxagen.ai` is a redirect, and it carries live mail

The domain is retired as a website. Apex and `www` answer every route with a
301 to the `oxagen.sh` homepage — path discarded, because the two domains never
shared a URL structure and a path-preserving redirect would answer most old
links with a 404 on the target.

**The website is the least of what the zone does.** Before changing anything in
`stacks/oxagen/dns-oxagen-ai.tf`, know what else is in there:

- **Mail.** Inbound routes through improvMX. Outbound is signed by Amazon SES,
  SendGrid, Stripe, Resend and Linear, each with its own DKIM keys, under SPF
  and DMARC records at three different names.
- **Live services.** `api`, `mcp`, `admin`, `redis`, `clickhouse` and `pgadmin`
  are served from a Google Cloud load balancer this migration never touched.
  `api` and `mcp` answer requests today.
- **Ownership proofs.** GitHub, Google, Discord, Anthropic, Mistral and Stripe
  each verify control of the domain through a TXT record.

`tools/import-dns.py` drops every `A` record, on the reasoning that an `A`
record is the old website. That was true for `oxagen.sh` and is false here, so
those six names are declared explicitly in the `oxagen_ai_elsewhere` variable.
Deleting them does not break the redirect — it takes an API down.

The failure mode throughout is quiet. A zone missing an `MX` record does not
return an error, it bounces mail; a missing DKIM key bounces nothing and just
starts landing in spam folders days later, with nothing pointing back at the
change that caused it.

## The certificate ordering trap

An ACM certificate validates by DNS, so it cannot issue until Route 53 is
authoritative for the domain. While the nameservers still point elsewhere,
`aws_acm_certificate_validation` blocks for its full 75-minute timeout and then
fails.

The sequence that avoids it:

1. Apply the zone and the certificates only (`-target`), which is enough to
   learn the nameservers.
2. Repoint the nameservers at the registrar.
3. Apply the rest. Validation records are already in the zone, so the
   certificates issue on their own.

### CAA will silently block issuance

Check the CAA records before assuming a certificate is merely slow. The zones
migrated here authorised `pki.goog`, `sectigo.com` and `letsencrypt.org` and
**not** `amazon.com`, which forbids ACM from issuing at all. There is no error
that says so — the request just stays `PENDING_VALIDATION` forever.

## Deploying is automatic now

Four repositories publish here on merge to `main`, and none of them holds an
AWS key. Each assumes a role over GitHub's OIDC provider, trusted on the exact
subject `repo:<owner>/<name>:environment:production` — an environment, not a
branch, so entry is a repository setting that can be revoked without a code
change, and a fork's pull request cannot mint an accepted token.

| Repository | Publishes |
| --- | --- |
| `macanderson/stella` | `stella.oxagen.sh` (node) |
| `macanderson/cgp-website` | `contextgraphprotocol.org` (S3 + CloudFront) |
| `macanderson/context-graph-protocol` | that site's `/schema` and `/spec` prefixes |
| `oxageninc/oxagen-platform` | `oxagen.sh` (S3 + CloudFront); `docs`, `app`, `api`, `mcp` (node) |

`stacks-new/ci-deploy` holds the provider, the four roles and their policies —
this is the live account's deploy path (`stacks/ci-deploy` is the equivalent
for the old, retired path). The roles are named in the workflows in plain
text, which is fine — a role ARN is an identifier, and it is useless without a
token whose subject the trust policy accepts.

**No CI role has a shell on the node.** Each may write one S3 object per service
it owns and send exactly one SSM document, `oxagen-deploy-service`, whose only
argument is a service name constrained by `allowedPattern` at the API. That
instance also runs Neo4j and ClickHouse (Postgres moved to Aurora Serverless
v2); `AWS-RunShellScript` on it is root, and no deploy needs root.

## Applying from CI

`.github/workflows/infra.yml` plans every pull request that touches
`stacks-new/` or `modules/` and applies on merge to `main`. A pull request
assumes `gha-infra-plan`, which can only read; a merge assumes
`gha-infra-apply`, pinned to the `production` environment. Both roles are
declared in `stacks-new/ci-deploy/infra-apply.tf`.

**Both roles are created by the stack they apply, so the first apply is by
hand.** Until it has happened, pull requests run `fmt` and `validate` only and
the plan step is skipped with a warning naming this section; the apply job on
`main` fails outright, which is the right signal for a write that cannot run.
With credentials for account `916294258235`:

```bash
cd stacks-new/ci-deploy && tofu init && tofu plan   # read it: two roles, three attachments
tofu apply
```

After that single apply the workflow is self-hosting: the next pull request
plans, and the next merge applies. Nothing in the workflow needs to change.

## Serving from the node

`stella.oxagen.sh`, `docs.oxagen.sh` and the platform's `app`, `api` and `mcp`
are Node processes on the shared instance behind Caddy, not Lambda. `internal.oxagen.sh`
(the password-protected internal docs) is a static export served by its own
Caddy container on the same node; see `tools/node/README.md`. **CloudFront
in front of a Lambda Function URL returns 403 for every request in this
account** — ruled out: the resource policy, `RESPONSE_STREAM` invoke mode, a
stale URL, and org SCPs (the account is in no Organization). A brand-new
Function URL with authorization disabled entirely still returned 403, which
should serve. Both functions render correctly under direct `lambda invoke`. Do
not spend hours on that path again.

`tools/node/` holds what runs there and `tools/node/README.md` documents the
`oxagen-run.json` contract an artifact must carry. `tools/caddy/Caddyfile` is
the front door. Install both:

```bash
tools/install-node-scripts.sh   # validates the Caddyfile before reloading it
```

**The node is `arm64`** (a `t4g.medium`). An artifact built on an x86 runner
installs and tests green, then fails to load a native module at first request.
Build jobs that target it run on `ubuntu-24.04-arm`.

## Deploying site content by hand

The workflows above do this; these are the same steps for a one-off.

```bash
# A site that is entirely files
tools/deploy-static.sh <build-dir> <bucket> <distribution-id>

# A site that runs code, on Lambda (see the 403 above — currently unused)
cd <app> && pnpm install --node-linker=hoisted && npx @opennextjs/aws build
tools/package-nextjs.sh <app>          # prints bundle_path and bundle_hash
cd stacks/<brand> && tofu apply
```

The `--node-linker=hoisted` is not optional and not cosmetic. pnpm's default
layout symlinks each package's own dependencies out of a content-addressed
store; a bundler that follows the symlink for `next` reaches the `next` package
and stops, leaving `next`'s own transitive dependencies behind. The bundle
imports fine locally and fails on its first cold start with `Cannot find module
'@swc/helpers/...'`. Passing it on the command line keeps the deploy correct
without changing how the repository installs for everyone else.

`package-nextjs.sh` then repairs a second, separate problem: Next traces the
module graph statically, so a package addressed by a path assembled at runtime
gets its `package.json` copied without its code. The script recopies any
bundled package that holds nothing but a manifest — on the Stella site that was
five packages, not the one that surfaced in the error.

## What alarms, and what each one is for

Every alarm lives in `infra/stacks-new/oxagen/alarms.tf` and sends to the
`oxagen-alerts` SNS topic. Nothing pages until `alert_email` is set in
`terraform.tfvars` — until then the alarms record state and drive the
dashboard, which is better than nothing and is not a notification.

Each one is here because something failed and nothing said so, so the list
reads as an incident history:

| Alarm | Fires when | The failure it is for |
|---|---|---|
| `oxagen-target-5xx` | The node answers real requests with 5xx | 2026-09-08: a node replacement came back with no services on it and passed its health check for two hours |
| `oxagen-tacho-ingress-5xx` | At least one Tacho intake 5xx in each of three consecutive 5-minute periods | #3167: the rate-limit store refused enrolled hosts while other requests succeeded |
| `oxagen-elb-5xx` | The load balancer itself errors | The ALB failing rather than the target |
| `oxagen-no-healthy-host` | The target group has no healthy target | |
| `oxagen-node-status-check` | The instance fails its EC2 status checks | |
| `oxagen-aurora-cpu` | Aurora saturates | |
| `oxagen-node-disk-{root,data}` | A filesystem is over 80% full | Deploys refuse to unpack under 3 GB free; at 100% SSM cannot reach the box to fix it |
| `oxagen-node-cpu` | Over 75% CPU for half an hour | 2026-08-25: ClickHouse burned its own system logs for 26 hours |
| `oxagen-node-cpu-credits` | The burst credit balance runs out | The same runaway, billing silently in `unlimited` mode |
| `oxagen-node-memory` | Over 90% memory | Two databases and six Node services on 8 GB; the OOM killer takes a database |
| `oxagen-container-restart-loop` | More than 5 container starts in each of three consecutive 5-minute periods | 2026-09-09 (#2813): a leftover `oxagen-worker` container restarted about 14 times a minute for two days and every alarm above stayed OK |

### The crash-loop alarm has parts outside `alarms.tf`

`oxagen-container-restart-loop` is the only alarm here whose metric does not
exist until something on the node publishes it, so it is four pieces rather
than one:

1. `infra/modules/app-node/monitoring.tf` installs a systemd unit that runs
   `docker events --filter event=start` and appends a line per container start
   to `/var/log/oxagen-docker-events.log`. It is installed by SSM State Manager,
   not user data, so adding it does not replace the instance.
2. The same file's CloudWatch agent config ships that file to
   `/oxagen-app/docker-events`.
3. `infra/stacks-new/oxagen/observability.tf` registers that log group in
   `local.log_group_services`, which is what gives it retention, tags and the S3
   archive.
4. `alarms.tf` counts the lines with a metric filter and alarms on the count.

Two things worth knowing before the next incident review:

- **It looks for a level, not a burst.** A deploy starts one container per
  service and is over inside a single period; a crash loop holds a rate. That is
  why the threshold is 5 rather than something near the incident's own 70 per
  period. The cost is that a container restarting slower than about once a
  minute stays under it. A slow loop is a real failure and this is not the thing
  that finds it.
- **Missing data is treated as quiet, not as broken.** A healthy node starts
  nothing for days, so the metric has no datapoint most of the time and a dead
  collector looks exactly like a calm one. `Restart=always` on the unit and the
  daily State Manager re-run are what hold it up; no alarm watches the watcher.

`tools/scripts/check-restart-alarm.mjs` (run by `pnpm check:contracts`) holds
those four pieces together, because each is joined to the next by a string
literal in a different file and every way of breaking the chain leaves valid
Terraform and an alarm that sits at OK forever.

## Reaching the databases

**This section is `stacks/oxagen-data` — the old account's self-hosted
Postgres, Neo4j and ClickHouse.** In the new account only Postgres is
managed: Aurora (`stacks-new/oxagen`'s `data-services.tf`) is reached over
the VPC from the app node, and its password lives at
`/oxagen-app/postgres/password` rather than under `/oxagen-data/`. ClickHouse
and Neo4j both run on the app node there, with passwords at
`/oxagen-app/clickhouse/password` and `/oxagen-app/neo4j/password`.

Nothing is exposed. The security group opens no inbound port and there is no
SSH key; every port is additionally bound to loopback on the instance, so a
mistaken rule still would not expose a database. Access is by SSM port-forward:

```bash
tofu -chdir=stacks/oxagen-data output connection_help
```

Passwords are generated by Terraform and stored in SSM Parameter Store, not in
outputs — an output would write them into the state file in plaintext.

```bash
aws ssm get-parameter --name /oxagen-data/postgres/password --with-decryption \
  --query Parameter.Value --output text
```

## Secrets

Application secrets live in Parameter Store under `/oxagen/production/`.
Parameter Store rather than Secrets Manager because standard parameters are
free where Secrets Manager bills $0.40 per secret per month — for this many
secrets, more per month than every website in this account combined.

`tools/migrate-secrets.py --plan` classifies a `.env` file into four buckets
and writes nothing until `--apply`, and even then writes only the first:

- **MIGRATE** — a live third-party credential AWS does not replace.
- **SUPERSEDED** — a credential for infrastructure this migration replaces.
  Copying it across would install a second, wrong answer.
- **ROTATE** — a credential that must be reissued rather than moved. Never
  written, because copying a known-exposed secret into a system-of-record
  makes it look clean without making it secret.
- **CONFIG** — not a secret. A flag, a public key, a model name, a URL.

### Tacho intake failure alert

`oxagen-tacho-ingress-5xx` counts JSON request records from `/oxagen-app/api`
with `msg: request`, a `/v1/tacho/` path, and status 500 through 599. It excludes
429 rate-limit refusals and failures on other API paths. Three consecutive
5-minute periods with at least one failure raise the alarm. A single deploy
burst does not. No traffic is non-breaching, so this alarm does not detect a
host that stops sending requests or an API process that emits no request logs.
The existing target and load-balancer alarms cover failures before request logging.

Apply the infrastructure change through the reviewed infrastructure workflow.
Confirm the SNS subscription before relying on notification delivery. Verify
`TachoIngress5xx` under `Oxagen/API`, then inspect the alarm state history and
confirm an alert arrives during a controlled canary. A filter-pattern test
validates selection without creating log records or changing alarm state.

Staging email is captured by Mailpit on the node. It has no outbound relay.
SMTP and the inbox bind only to loopback. STARTTLS remains required, and Node
trusts the staging certificate through a read-only certificate mount rather
than disabling TLS verification. Use an SSM port-forwarding session to port
8025 to read verification links. The inbox is capped at 500 messages and is
lost when its container is recreated. The local certificate lasts 365 days;
replace its certificate and key, restart Mailpit, and redeploy the services
before it expires. Customer stacks keep `capture_email = false` and supply
an operational SMTP provider.
