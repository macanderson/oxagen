# @oxagen/database

`@oxagen/database` owns the Postgres schema and every way code reaches Postgres. It holds the Drizzle schemas, the Atlas migrations, the row-level security policy manifest, and the scope-aware transaction wrappers `withTenantDb`, `withOrgDb`, and `withSystemDb`.

## Boundary

- **Owns:**
  - The Drizzle schema for every Postgres domain (`src/schema/`, exported as `schema`) and the cross-domain relations (`src/relations.ts`).
  - Versioned SQL migrations in `atlas/migrations/` with their `atlas.sum`, configured by `atlas.hcl`.
  - The row-level security policy class for each tenant table (`src/tenant-policy.manifest.ts`).
  - The transaction wrappers in `src/tenant.ts` and the boot check `assertRlsConnectionSafe`.
  - The platform data-plane resolver for dedicated organisation stores (`src/data-plane-resolver.ts`, ADR-042).
  - The security-event writer (`src/security.ts`) and the KMS resolvers for stored model credentials, assistant model keys, and SSO secrets.
  - Platform seeding (`src/seed.ts`) and the committed storage manifest (`storage-manifest.json`).
- **Does not own:**
  - The tenant scope context and the data-plane seam it resolves through: [`@oxagen/tenancy`](../tenancy/README.md) (`src/scope.ts`, `src/data-plane.ts`).
  - Neo4j access: [`@oxagen/ontology`](../ontology/README.md). ClickHouse access and its migrations: [`@oxagen/telemetry`](../telemetry/README.md).
  - The security-event taxonomy: [`@oxagen/compliance`](../compliance/README.md).
  - Applying migrations to production: `migration-gate` in `.github/workflows/pipeline.yml` (SCR-006).
  - IAM role and permission seeding: `tools/scripts/seed-iam-defaults.ts` (`pnpm db:seed-iam`).
- **Depends on:**
  - `@oxagen/tenancy`: the active scope for `withTenantDb`, and `setDataPlaneResolver` for the resolver seam.
  - `@oxagen/config`: `requireEnv` for `DATABASE_URL` and the RLS enforcement flag.
  - `@oxagen/crypto`: KMS envelopes for data-plane, model-credential, assistant-key, and SSO secrets.
  - `@oxagen/compliance`: the event types that generate the `security_events` `CHECK` constraint.
  - `@oxagen/telemetry`: security-event recording and seed logging.
  - `@oxagen/oxagen`: context types used by `src/tenant.ts`.
  - `@oxagen/run-evidence`: run verdict and witness reads in `src/proof.ts`.
- **Used by:** `apps/api`, `apps/app`, `apps/mcp`, `apps/app_deprecated`, `@oxagen/agent`, `@oxagen/ai`, `@oxagen/auth`, `@oxagen/billing`, `@oxagen/github`, `@oxagen/handlers`, `@oxagen/iam`, `@oxagen/inngest-functions`, `@oxagen/notifications`, `@oxagen/plugins`, `@oxagen/rules`, `@oxagen/run-ledger`, and `tools/scripts`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `withTenantDb(fn)` | boundary | `packages/database/src/tenant.ts` | Scoped handlers. Sets the org, workspace, and bypass settings the RLS policies read, on the organisation's data plane |
| `withOrgDb(fn)` | boundary | `packages/database/src/tenant.ts` | Organisation-wide reads with RLS still on (ADR-074) |
| `{ plane: "shared" }` on `withTenantDb` and `withOrgDb` | boundary | `packages/database/src/tenant.ts` | The billing seams in `packages/billing/src/internal/platform-db.ts`, which open billing tables on the shared plane with the same settings (#4338). The root ESLint config refuses the option in any other file |
| `withSystemDb(fn)` | boundary | `packages/database/src/tenant.ts` | Identity resolution, webhooks, cron, and bootstrap. Always the shared plane. `pnpm check:system-db` (part of `pnpm check:contracts`) fails on an unjustified call |
| Raw `db()` ban | boundary | `eslint.tenancy-seams.mjs` | Both ESLint configs. `packages/auth/src/auth.ts` is the one authorised consumer outside this package |
| `bootstrapDataPlaneResolver()` calls `setDataPlaneResolver` | injection | `packages/database/src/data-plane-resolver.ts` | `apps/app/instrumentation.ts`, `apps/api/src/bootstrap.ts`, and `apps/mcp/src/middleware.ts` |
| `assertRlsConnectionSafe()` | boundary | `packages/database/src/tenant.ts` | Refuses to boot when production disables RLS or the role bypasses it. Called in `apps/app/instrumentation.ts` and `apps/api/src/bootstrap.ts` |
| `makeSecurityEventInserter()` | export | `packages/database/src/security.ts` | The kernel security-event emitter in `apps/app/instrumentation.ts` and `apps/api/src/bootstrap.ts` |
| Tenant policy manifest | boundary | `packages/database/src/tenant-policy.manifest.ts` | `tools/scripts/gen-rls-migration.ts` generates the policy DDL. `integration/manifest-coverage.test.ts` checks every `org_id` table appears |
| `seedPlatform()` | export | `packages/database/src/seed.ts` | `tools/scripts/seed-platform.ts` (end of `pnpm db:migrate`) and `infra/tools/run-db-migrations.sh --apply` |

## Entry points

- `.` (`src/index.ts`): the transaction wrappers, `schema`, `relations`, the RLS boot checks, test mocks (`makeWithTenantDbMock` and siblings), and shared helpers.
- `./schema` (`src/schema/index.ts`): the Drizzle schema alone.
- `./client` (`src/client.ts`): the raw pool behind `db()`. Lint bans `db` from this path outside the package.
- `./tenant` (`src/tenant.ts`): the wrappers without the barrel.
- `./security` (`src/security.ts`): security-event emission.
- `./seed` (`src/seed.ts`): platform and dev seeding.
- `./data-plane` (`src/data-plane-resolver.ts`): `bootstrapDataPlaneResolver` and graph data-plane records.
- `./model-credential`, `./model-credential-shape`, `./assistant-model-key`, `./sso-secrets`: KMS resolvers and shapes for stored secrets.

## Rules

- Use `withTenantDb` or `withSystemDb`. Raw `db()` is banned, and ESLint enforces the ban on both `@oxagen/database` and `@oxagen/database/client`.
- A `withSystemDb` call carries a `tenancy: system bypass` comment saying why. Handlers use `withTenantDb` so RLS stays load-bearing.
- A row whose `workspace_id` differs from the session's workspace must fit the table's policy class in `src/tenant-policy.manifest.ts`, or RLS refuses the write.
- Keep a `withTenantDb` callback short. The transaction stays open for the callback's lifetime, so do not wrap a model or tool call in it.
- The Drizzle schema is the source of truth. Generate a migration with `atlas migrate diff --env local "<name>"` from this directory, stamp it later than every migration on `main`, and regenerate the checksum with `atlas migrate hash --dir "file://atlas/migrations"`. Never hand-edit `atlas.sum`.
- `pnpm --filter @oxagen/database migrate` (drizzle-kit) is disabled on purpose. `drizzle/` holds the pre-Atlas ordinal series that `pnpm db:lint-migrations` lints. Add nothing there.
- A schema-changing PR carries the `migration-required` label, which `migration-label.yml` applies. `migration-gate` applies the migration on merge (SCR-006). Write no apply steps and apply nothing by hand.
- After adding a table or capability, run `pnpm schema:manifest` and commit `storage-manifest.json`. `pnpm schema:manifest:check` fails CI when it is stale.
- Organisation stores resolve through `resolveDataPlane()` in `@oxagen/tenancy` (ADR-042). `withSystemDb` never consults it.

## Tests

```bash
pnpm --filter @oxagen/database test:unit src/tenant.test.ts
```

Never put `--` before the filename. Unit tests live beside the source in `src/` and in `src/__tests__/`. Tests that need a live Postgres live in `integration/` and run in CI's `pipeline.yml` through `pnpm --filter @oxagen/database test:integration`.
