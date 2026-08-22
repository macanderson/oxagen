# Root `pnpm` scripts

Every script in the repo-root `package.json`, what it does, and when to reach
for it. Package-local scripts (`apps/*/package.json`, `packages/*/package.json`)
are not listed here — run those via `pnpm --filter <pkg> <script>`.

| Script | Purpose | When to use |
|---|---|---|
| `preinstall` | Blocks any install that isn't `pnpm` (`npx only-allow pnpm`). | Runs automatically; never invoke directly. |
| `prepare` | Installs the Lefthook git hooks (`lefthook install`). | Runs automatically after `pnpm i`. |
| `dev` | Starts every app (`app`, `api`, `mcp`, `docs`, …) plus the Docker datastores (Postgres, ClickHouse, Neo4j), the Stripe webhook tunnel, and the Inngest dev server. | Day-to-day local development. Long-running — background it. |
| `kill` | Stops all `pnpm dev` processes, the Stripe tunnel, the Inngest dev server, and (with `--volumes`) tears down Docker volumes. | Before restarting the stack, or when a port is stuck in use. |
| `clean:cache` | Deletes every app's `.next/dev/cache` directory. | Clearing a corrupted/stale Next.js dev cache. |
| `env:pull` | Pulls `.env.local` for every linked project from Vercel's Development environment. | After someone edits env vars in the Vercel dashboard. |
| `vercel:rotate-ai-key` | Mints a new Vercel AI Gateway key and rolls it out to every local env file and Vercel project. | Rotating the shared AI Gateway credential. |
| `env:manager` | Runs the `@oxagen/env-manager` app in dev mode. | Managing/editing env var definitions interactively. |
| `env:secrets:pull` | Pulls secrets via `@oxagen/env-manager`. | Refreshing local secrets outside the full `env:pull` flow. |
| `build` | Full monorepo build (`turbo run build`). | Before merging — part of the three-command gate. |
| `lint` | Runs ESLint across every package (`turbo run lint`). | Part of `pnpm gate`; also run scoped via `turbo run lint --filter=<pkg>`. |
| `format` | Formats the whole repo with Biome (`biome format --write .`). | One-shot formatting sweep; not yet run automatically in CI (see ADR-015). |
| `format:check` | Checks formatting without writing (`biome format .`). | CI-style formatting check. |
| `typecheck` | Runs `tsc` across every package (`turbo run typecheck`). | Part of `pnpm gate`. |
| `test` | **Do not run directly** — runs `turbo run test:unit` across every package. Use `pnpm --filter <pkg> test:unit -- <file>` instead. | Never invoke whole-repo; CI runs it. |
| `test:coverage` | **Do not run directly** — runs `turbo run test:coverage` across every package. | CI only; use a single package's `test:coverage` locally. |
| `test:e2e` | Runs the Playwright e2e suite for `@oxagen/app`. | Full e2e run; prefer a single spec file locally. |
| `db:migrate` | Applies pending Postgres migrations (Atlas), then runs the ClickHouse/Neo4j migrator and the platform seed. | Bringing local/preview/prod schema up to date. |
| `db:migrate:pg` | Applies only the Postgres (Atlas) migrations for the `local` env. | Postgres-only migration apply. |
| `db:migrate:diff` | Generates a new Atlas migration from the current Drizzle schema diff. | After changing `packages/database` schema — creates the migration file. |
| `db:atlas-dev-setup` | Ensures the `atlas_dev` scratch database exists with required Postgres extensions. | Before `atlas migrate diff`; idempotent. |
| `db:atlas-validate` | Validates the Atlas migration directory's checksums. | Part of `pnpm gate`; also runs in the `atlas-validate` pre-commit hook when migration files are staged. |
| `db:seed-platform` | Seeds the Free/Build/Scale/Enterprise billing plans (idempotent). | After a fresh migration apply. |
| `db:generate` | Runs `drizzle-kit generate` for `@oxagen/database`. | After editing the Drizzle schema, to emit SQL. |
| `db:check` | Lightweight schema-presence probe against every store. | Quick health check that migrations actually landed. |
| `db:lint-migrations` | Statically lints the migration folder (naming, ordinal gaps/duplicates). | Part of `pnpm gate`; catches structural mistakes before `db:migrate` runs. |
| `db:reset` | **Destructive.** Tears down Docker volumes and re-applies all migrations from scratch. | Local dev only, when the DB needs a clean slate. |
| `db:seed-iam` | Seeds `org.role_grants` for every system role in every org from each contract's `defaultRoles`. | After adding/changing a capability's default IAM roles. |
| `db:seed-skills` | **Deprecated** — no-op; skills are now seeded per-workspace at creation time. | Do not use; kept for historical reference. |
| `db:seed-interactive-agent` | Ensures every workspace has the built-in `qa-chat` interactive agent published. | After changing the built-in agent config, or backfilling old workspaces. |
| `db:backfill-iam` | Idempotently backfills IAM principals/roles for orgs created before IAM bootstrap existed. | One-time backfill after enabling `IAM_ENFORCEMENT_ENABLED`. |
| `db:backfill-capabilities` | Backfills the default first-party `agent_capability` packs into pre-existing workspaces. | One-time backfill after adding new default capability packs. |
| `db:backfill-workspace-seeds` | Backfills the MCP registry, capability packs, and skill templates into pre-existing workspaces. | One-time backfill after wiring new workspace-creation seeders. |
| `db:backfill-mcp-server-auth-config` | Encrypts legacy plaintext `mcp_servers.auth_config` rows in place. | One-time backfill after the auth-config encryption fix landed. |
| `check:manifest` | Regenerates the capability manifest and warns (exit 0) on any declared layer missing a file on disk; `--strict` exits 1. | Verifying API/MCP capability parity; part of `pnpm gate`. |
| `check:ui-parity` | Enforces the UI Capability Parity law — every `app`-layer capability must have a working, proven page. | Part of `pnpm gate`; run after wiring up new app UI. |
| `check:mobile-parity` | Enforces the Mobile Feature Parity law (ADR-026) — no undeclared mobile-hidden features. | Part of `pnpm gate`; run after adding responsive-display utilities. |
| `check:vision` | LLM-judges a PR diff against `docs/VISION.md` and posts an advisory verdict. | Runs in the Vision Gate CI workflow; can run locally against `origin/main`. |
| `check:manifest:tickets` | Files/updates a Linear umbrella ticket for capability manifest gaps. | CI-only housekeeping; keeps Linear in sync with `check:manifest`. |
| `e2e:failure-ticket` | Files/updates an idempotent Linear ticket when the nightly e2e job fails. | Invoked by the nightly CI workflow on failure. |
| `check:contracts` | Verifies every contract file is registered in its package's `contracts[]` array, then checks naming. | Part of `pnpm gate`; also the `pre-push` hook. |
| `check:naming` | Enforces the ADR-025 verb-first snake_case capability naming standard. | Run standalone when adding a new capability name. |
| `check:connector-schemas` | Verifies every built-in connector has a matching `schema.yaml` and vice versa. | Part of `pnpm gate`; run after adding/editing a connector. |
| `docs:schemas` | Generates per-capability input/output JSON Schema docs from Zod contracts. | After changing a contract's input/output shape. |
| `env:check` | Reconciles env-var references in code against `ENV_REGISTRY` and verifies `.env.example` is current; `--write` regenerates it. | Part of `pnpm gate`; also the `pre-push` hook. Run `--write` after adding a new env var. |
| `eval` | Runs the in-process engram context-quality eval suite and ingests results into ClickHouse. | Quick, free, no-Docker eval run. Pass a `.eval.json` path to ingest existing results instead. |
| `eval:ingest` | Loads a normalized `*.eval.json` file into ClickHouse eval tables. | Landing results from the heavier Python eval harnesses (rag-eval, context-eval). |
| `gate` | The full CI suite: affected lint/typecheck/test/coverage/build, plus manifest/UI-parity/mobile-parity/contracts/connector-schema/env/migration checks. | Pre-merge, once a body of work is finished — not per-commit (see CLAUDE.md). |
| `release` | Runs the lockstep monorepo release (defaults to no bump — see `release:*`). | Rarely invoked directly; prefer `release:patch`/`minor`/`major`. |
| `release:patch` / `release:minor` / `release:major` | Bumps every package's version in lockstep, regenerates AI release notes, tags, and propagates `PLATFORM_VERSION` to every Vercel project/environment. | Cutting a new platform release. |
| `billing:stripe-sync` | Reconciles Stripe products/prices and `billing.plans` against `@oxagen/billing`'s pricing source of truth. `--apply` writes; default is dry-run/report. | After changing pricing in `packages/billing/src/pricing.ts`. |
| `metrics:fanout` | Compares subagent-fanout ClickHouse metrics (calls-per-dispatch, fan-back ratio, token usage) before/after a cutover date. | Measuring the impact of a fanout/dispatch change. |

## Notes

- **Never run whole-repo test scripts locally** (`test`, `test:coverage`, `gate`'s
  test steps) — they exist for CI. Use `pnpm --filter <pkg> test:unit -- <file>`
  for a single file, or `turbo run test:unit --filter=<pkg>` for one package.
- Scripts prefixed `db:backfill-*` and `db:seed-skills` are one-time or
  deprecated migrations — read the script's own header comment
  (`tools/scripts/<name>.ts`) before running against a non-empty database.
- Most `tsx`-run scripts accept `--env-file-if-exists=.env.local`; confirm the
  target database/environment before running any mutating script (see
  CLAUDE.md's "Database and migration targeting").
