# oxagen-aws-infra

Infrastructure for three brands — **Oxagen**, **Stella**, and the **Context
Graph Protocol** — in one AWS account (`578673726240`), kept separate by
tagging, Resource Groups, and per-brand Terraform state rather than by separate
accounts.

Managed with [OpenTofu](https://opentofu.org). State lives in
`s3://oxagen-tfstate-578673726240` with locking in the `oxagen-tflock`
DynamoDB table, both of which predate this repository.

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
  data-node/     Postgres + Neo4j + ClickHouse on one instance
stacks/
  oxagen/        oxagen.sh zone, marketing site, docs site
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
cd stacks/oxagen     && tofu init && tofu apply
cd stacks/cgp        && tofu init && tofu apply
cd stacks/stella     && tofu init && tofu apply   # needs parent_zone_id
cd stacks/oxagen-data && tofu init && tofu apply
```

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

## Deploying site content

```bash
# A site that is entirely files
tools/deploy-static.sh <build-dir> <bucket> <distribution-id>

# A site that runs code
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

## Reaching the databases

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
