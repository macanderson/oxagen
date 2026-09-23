# @oxagen/scripts

The repository's operator and CI scripts: the integrity checks behind
`pnpm check:*` and `pnpm gate`, database migration and seed runners, code
and docs generators, backfills, release tooling, and local dev helpers.

## Boundary

- **Owns:** every script under `tools/scripts/` and the shared helpers in
  `tools/scripts/lib/`. The root `package.json` maps most `pnpm <name>`
  commands to a file here, so read it for the current command-to-file map.
- **Does not own:** the rules the checks enforce, which live with their
  owners: capability contracts in
  [`@oxagen/oxagen`](../../packages/oxagen/README.md), the env registry in
  [`@oxagen/config`](../../packages/config/README.md), the Postgres schema and
  migrations in [`@oxagen/database`](../../packages/database/README.md), and
  the app's UI bindings in `apps/app/capability-ui-map.json`. It also does not
  own the SEA compiler ([`tools/sea`](../sea/README.md)), the package-manager
  templates ([`tools/packaging`](../packaging/README.md)), or the env
  manager UI ([`tools/env-manager`](../env-manager/README.md)).
- **Depends on:** `@oxagen/config` (env), `@oxagen/database`,
  `@oxagen/ontology`, and `@oxagen/telemetry` (the three stores, for
  migrations, seeds, and backfills), `@oxagen/oxagen` and `@oxagen/handlers`
  (the contract registry for manifest and docs generation), `@oxagen/iam`
  (IAM seeding), `@oxagen/billing` (Stripe and price-book sync),
  `@oxagen/agent`, `@oxagen/ai`, and `@oxagen/tenancy`. Read `package.json`
  for the current list.
- **Used by:** the root `package.json` scripts, `lefthook.yml`, and CI
  workflows. No package imports it.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `pnpm check:*`, `pnpm db:*`, `pnpm docs:*`, `pnpm release:*`, `pnpm dev`, `pnpm env:check` | boundary | `tools/scripts/*.{ts,mjs}` | Root `package.json` |
| Pipeline steps (`check-main-preflight.mjs`, `check-deploy-tip.mjs`, `check-stale-merge-base.mjs`, `check-coverage-gates.mjs`, `build-env.ts`, `seed-platform.ts`) | boundary | `tools/scripts/` | `.github/workflows/pipeline.yml` |
| ClickHouse and Neo4j migrations (`db-migrate.ts`) | boundary | `tools/scripts/db-migrate.ts` | `.github/workflows/pipeline.yml` (with `DB_MIGRATE_STORES=clickhouse,neo4j`) and `.github/workflows/store-migrate.yml` |
| Store migration tunnel (`coordinatorTunnel`) | export | `tools/scripts/store-migrate-coordinator.mjs` | `.github/workflows/store-migrate.yml` |
| Staged-file typecheck | boundary | `tools/scripts/typecheck-staged.mjs` | `lefthook.yml` pre-commit |
| `APP_DIR` (which app the parity gates read) | export | `tools/scripts/lib/app-dir.mjs` | `check_ui_parity.mjs`, `check_mobile_parity.mjs`, `check_manifest.mjs` |
| RLS policy migration generator | boundary | `tools/scripts/gen-rls-migration.ts` | Reads `packages/database/src/tenant-policy.manifest.ts`, writes `packages/database/atlas/migrations/` |
| Raw database access exemption | boundary | `eslint.config.mjs` (`files: ["tools/scripts/**"]`) | ESLint turns off the tenancy import ban here, because these scripts run as a trusted operator across tenants |

## Entry points

There is no `exports` map. Each file is a command, run with `tsx` or `node`,
usually through a root `pnpm` script. `lib/` holds the helpers they share,
for example `release-notes.ts`, `versions.ts`, and `env-targets.ts`.

## Rules

- A script that writes across tenants prints and confirms the target
  database before its first write. The ESLint exemption in
  `eslint.config.mjs` is granted on that condition. Unset a shell-exported
  `DATABASE_URL` when `.env.local` should choose the target.
- A new check is wired into the root `package.json` and into the CI job that
  must run it. A check nothing runs protects nothing.
- Never print credentials.

## Tests

```bash
pnpm --filter @oxagen/scripts test:unit app-dir.test.ts
```

Never put `--` before the filename. Tests sit beside their scripts as
`<name>.test.ts`, including under `lib/`, and `vitest.config.ts` collects
`**/*.test.ts`.
