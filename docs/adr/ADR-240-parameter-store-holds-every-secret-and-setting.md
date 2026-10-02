# ADR-240: Parameter Store holds every secret and setting

- **Status:** Accepted
- **Date:** 2026-09-30
- **Owners:** platform
- **Supersedes:** ADR-004
- **Related:** issue #4925, #4832, #4833, ADR-088, ADR-150,
  `packages/config/src/registry.ts`, `packages/config/src/ci-registry.ts`,
  `tools/scripts/env-pull.ts`, `tools/scripts/env-push.ts`,
  `tools/scripts/build-env.ts`, `infra/tools/node/deploy-service.sh`,
  `docs/runbooks/secrets-and-variables.md`.

## Context

On 2026-09-30, Oxagen's secrets and settings sat in four places:

| Store | What reads it |
|---|---|
| SSM Parameter Store, `/oxagen/production` and `/oxagen/staging` | The app nodes at container start (`deploy-service.sh`), and the CI build through `build-env.ts` |
| Vercel project env, Development target | `pnpm env:pull`, which wrote the four local `.env.local` files with `vercel env pull` |
| GitHub Actions secrets and variables | 17 workflows. The repository held 43 secrets, and no workflow read 33 of them |
| Google Secret Manager, project `oxagen-490023` | The local `tools/env-manager` `/secrets` page, and nothing else |

Production moved to AWS on 2026-08-27 and reads Parameter Store. Nothing has
deployed to Vercel since, yet a new laptop still needed `vercel link` in four
directories before `pnpm dev` would start. Vercel's Sensitive variables cannot
be read back at all, so a value only reached a laptop through `vercel env pull`
when it was stored as a readable variable. The local copy of a secret was
therefore either missing or kept where anyone on the team could read it.

ADR-004 still said secrets were plain environment variables and that the GCP
path was gone. Neither matched what ran. `infra/README.md` and
`infra/docs/new-account-migration-plan.md` had already chosen Parameter Store
over Secrets Manager, but no ADR recorded it.

Two failures came out of the split. #4832: production never received `APP_URL`
because no parameter held it, so Connect Slack and Linear stayed off. #4833:
the registry and `/oxagen/production` disagree on five values, so an
environment built from the registry would run something production does not.

Nothing recorded how to mint a new value. When a key leaked or expired, the
steps lived in someone's memory.

## Decision

### One store

SSM Parameter Store in account 916294258235, region us-east-1, holds every
secret and every setting that differs by environment. Each name is
`<prefix>/<KEY>`:

| Prefix | Holds | Read by |
|---|---|---|
| `/oxagen/production` | Production values | The app node at container start. The production build (`build-env.ts`) |
| `/oxagen/staging` | The registry's `preview` environment (ADR-150) | The staging node and the staging build |
| `/oxagen/development` | Values every laptop shares: sandbox and test keys, OAuth apps registered for localhost, the local Docker URLs | `pnpm env:pull` |
| `/oxagen/operator` | Maintainer tooling secrets no service reads: npm publish, desktop signing, the Linear API key | `pnpm env:pull --operator`, root `.env.local` only |
| `/oxagen/ci` | CI secrets, from phase 3 | Workflows, through the OIDC roles they already assume |

The paths Terraform writes stay where they are: `/oxagen-app/*`,
`/oxagen-staging-app/*`, and the `stella-serve` and `internal-docs`
sub-prefixes.

A variable the registry marks `secret` is a SecureString. Anything else is a
String. SecureStrings use the AWS-managed `aws/ssm` key, as production does
today. A value over 4 KB needs the Advanced tier, and `pnpm env:push` picks it.

### The registry says where each value lives

`packages/config/src/registry.ts` stays the contract: names, the services that
read each one, the environments that require it, and the static values. Two
fields join it:

- `store` says where the value is kept: `environment`, `operator`, `ci`,
  `registry` (a static value in the file), or `shell` (set by hand or by a
  script, never stored). `storeOf()` derives it when an entry leaves it out.
- `refresh` says how to mint or fetch a new value, with the command when one
  exists. A test fails when an `environment` or `operator` variable has none.

`packages/config/src/ci-registry.ts` does the same for every GitHub secret and
variable a workflow reads. `pnpm env:check` fails when a workflow reads one the
file does not list, or when the file lists one no workflow reads.

A static value lives in the registry only. A parameter that repeats it is
drift, which `build-env.ts` already reports (#4833).

The Architecture Atlas renders the inventory in its Secrets and variables
section: every stored variable, its parameter names, where it is required, and
its refresh steps.

### Local files come from the store

`pnpm env:pull` reads `/oxagen/development` with
`aws ssm get-parameters-by-path --recursive --with-decryption` and writes the
four `.env.local` files: the root, `apps/app`, `apps/api`, and `apps/mcp`.

- **Precedence.** A registry static value wins, then the parameter, the same
  order `build-env.ts` uses. A variable in neither is left out, and a required
  one is named in a warning.
- **The same set in every file.** The node injects every parameter into every
  container (ADR-088). Writing a per-service subset would create a local
  failure production does not have.
- **Local overrides survive.** Each file ends with a marker line. The pull
  rewrites everything above it and keeps everything below it, and a key below
  the marker wins. The first pull over an old file carries its keys the store
  lacks into that block and keeps the old file as `.env.local.bak`.
- **Production stays off laptops.** `--env production` is refused. `--env
  staging` is allowed for debugging the staging stack.

`pnpm env:push <KEY> --env <env>` writes one value, read from stdin or a
prompt and never from the command line. `pnpm env:push --from .env.local --env
development --apply` seeds a prefix from a working file. It refuses
production, where changes go one key at a time.

### Rotation

A runtime value takes effect when the service restarts: the node reads
Parameter Store at container start. A `NEXT_PUBLIC_` value is compiled into the
bundle and needs a rebuild. The general procedure is: mint the new value where
the registry's `refresh` says, save it with `pnpm env:push`, restart or
rebuild, confirm the service works, then revoke the old value at the vendor.
`docs/runbooks/secrets-and-variables.md` has the commands.

## Alternatives considered

- **Secrets Manager.** Built-in rotation suits database credentials, and
  Terraform already generates those into Parameter Store. Most of Oxagen's
  secrets are vendor keys rotated at the vendor. At $0.40 per secret per
  month, about 90 values in each of three environments costs more than $100 a
  month, where standard parameters cost nothing. A whole environment also
  takes one `get-parameters-by-path` call, against one call per secret.
- **Vercel environment variables.** A Sensitive variable cannot be pulled, and
  nothing deploys to Vercel.
- **Doppler or 1Password.** Each adds a vendor, a login, and a sync step, and
  production would still read Parameter Store.
- **Google Secret Manager.** Oxagen runs nothing on GCP.

## Plan

Each phase leaves the tree working. Phases 2 and later need AWS or GitHub
credentials, so a maintainer runs them.

1. **Store and tooling (#4925).** This ADR, the `store` and `refresh` fields,
   `CI_REGISTRY` and its `env:check` rule, `pnpm env:pull` on Parameter Store,
   `pnpm env:push`, the Atlas inventory, and the runbook.
2. **Seed development.** On a laptop whose `.env.local` works, run
   `pnpm env:push --from .env.local --env development`, read the plan, then
   repeat with `--apply`. Do the same for `/oxagen/operator`. On a clean
   checkout, `pnpm env:pull` and `pnpm dev` must start the stack with no other
   step.
3. **CI reads the store.** Copy each secret in `CI_REGISTRY` to `/oxagen/ci`,
   give the workflow roles read access to that prefix, and replace each
   `secrets.X` with a read through
   `aws-actions/configure-aws-credentials`. A fork pull request cannot assume a
   role, so `STRIPE_TEST_SECRET_KEY` and `AUTH_TOKEN_ENCRYPTION_KEY` in the e2e
   jobs stay GitHub secrets. Then delete the repository secrets no workflow
   reads, listed under Cleanup below.
4. **Retire Vercel and GCP.** Delete `tools/env-manager` and its scripts, the
   `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `GCP_PROJECT` registry entries, and
   `pnpm vercel:rotate-ai-key`'s Vercel rollout step. Delete the Vercel
   projects' environment variables and the GCP secrets once phase 2 has every
   value they held.
5. **Access and audit.** Add a developer IAM group that can read
   `/oxagen/development/*` and decrypt through SSM, so a second engineer needs
   no admin user. Consider a customer-managed KMS key for the SecureStrings, so
   CloudTrail records each decrypt against one key. Per-service runtime
   prefixes remain ADR-088's open item.

### Cleanup

On 2026-09-30 the repository held these secrets, and no workflow read any of
them:

`ATLAS_CLOUD_TOKEN_RAWR7F`, `BETTER_AUTH_API_KEY`, `BETTER_AUTH_SECRET`,
`BLOB_READ_WRITE_TOKEN`, `BLOB_STORE_ID`, `DEPLOYMENT_TOKEN`, `GH_PAT`,
`GOOGLE_LOGIN_CLIENT_ID`, `GOOGLE_LOGIN_CLIENT_SECRET`,
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `OPENAI_API_KEY`,
`PREVIEW_CLICKHOUSE_DATABASE`, `PREVIEW_CLICKHOUSE_PASSWORD`,
`PREVIEW_CLICKHOUSE_URL`, `PREVIEW_CLICKHOUSE_USERNAME`,
`PREVIEW_NEO4J_DATABASE`, `PREVIEW_NEO4J_PASSWORD`, `PREVIEW_NEO4J_URI`,
`PREVIEW_NEO4J_USERNAME`, `PRODUCTION_CLICKHOUSE_DATABASE`,
`PRODUCTION_CLICKHOUSE_PASSWORD`, `PRODUCTION_CLICKHOUSE_URL`,
`PRODUCTION_CLICKHOUSE_USERNAME`, `PRODUCTION_DATABASE_URL`,
`PRODUCTION_NEO4J_DATABASE`, `PRODUCTION_NEO4J_PASSWORD`,
`PRODUCTION_NEO4J_URI`, `PRODUCTION_NEO4J_USERNAME`, `SMTP_PASSWORD`,
`STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, and `TAVILY_API_KEY`.

The repository-level `STRIPE_SECRET_KEY` is also unread: `stripe-sync.yml`
reads the production environment's copy. The production environment also holds
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_PUBLISHABLE_KEY`, and
`STRIPE_WEBHOOK_SECRET`, which no workflow reads.

Several hold production database credentials. Before deleting, confirm with
`rg -n 'secrets\.<NAME>' .github` that nothing reads the name, then run
`gh secret delete <NAME>` from a checkout.

These secrets are read by a workflow and were not set on 2026-09-30. Each
workflow skips the step or falls back while the secret is empty: the six
`APPLE_*` secrets, `FLEET_OPERATOR_TOKEN`, `LINEAR_ACCESS_KEY`, the three
`OXAGEN_CONTAINED_*` secrets, `SCR_CORPUS_TOKEN`, and the three
`STEERING_LIVE_*` secrets.

## Consequences

- A new laptop needs the AWS CLI v2 and credentials for the account. It no
  longer needs the Vercel CLI or a Vercel login.
- One write changes a value for everyone. A wrong value in
  `/oxagen/development` reaches every laptop at its next pull, the same way a
  wrong value in `/oxagen/production` reaches production at its next restart.
- Every stored variable has a refresh step, and a test keeps it that way. CI's
  secrets have one too, and `env:check` keeps that list in step with the
  workflows.
- The registry's `secret` flag now means SecureString, not Vercel's encrypted
  type.
- Until phase 3, CI keeps its own copies in GitHub. Until phase 4, the Vercel
  projects and the GCP project still hold stale copies.
