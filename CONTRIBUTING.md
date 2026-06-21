# Contributing

## Prerequisites

- Node.js 24+ (`node -v`)
- pnpm 11+ (`npm i -g pnpm`) — the repo pins `pnpm@11.7.0` via `packageManager`
- Docker (for local Postgres, Neo4j, ClickHouse)

## First-Time Setup

```bash
cp .env.example .env.local   # fill in required values
pnpm install
pnpm env:check               # validate .env.local
pnpm dev                     # starts Docker + migrations + all apps
```

## Before Every Commit

**The gate must pass:**

```bash
pnpm gate     # lint + typecheck + tests + build + manifest + contracts + env + db
```

If `gate` fails on any step, fix it before committing. The CI gate is identical.

## Adding a Feature

### New Capability

1. Define the contract in `packages/oxagen/src/contracts/<name>.ts`
2. Add the barrel import to `packages/oxagen/src/contracts/index.ts`
3. Implement the handler in `packages/handlers/src/<name>.ts`
4. Register it in `packages/handlers/src/register.ts`
5. If exposing on MCP: add `apps/mcp/src/tools/<name>.ts`
6. If exposing on CLI: add `apps/cli/src/commands/<name>.ts`
7. Write unit tests — coverage must meet the package threshold
8. Run `pnpm check:manifest` to verify parity

Contract fields that require careful thought:
- `defaultEffect`: use `"deny"` for most capabilities; `"allow"` only for truly public reads
- `sensitivity`: drives IAM audit logging and default grant decisions
- `noBillingGate`: set to `true` for management/settings ops that don't consume AI credits
- `defaultRoles`: seed IAM grants — these become the defaults in `seed-iam-defaults.ts`

### New Postgres Schema

Schemas go in `packages/database/src/schema/`. Use the existing `pgSchema()` pattern:

```typescript
import { someSchema } from "./_schemas";
export const myTable = someSchema.table("my_table", { ... });
```

Create the migration:
```bash
pnpm db:migrate:diff   # generates Atlas migration file
pnpm db:lint-migrations  # verify integrity
pnpm db:migrate        # apply locally
```

Never create migration files manually — always use `atlas migrate diff`.

### New Inngest Function

Add to `packages/inngest-functions/src/functions/`. Register in `src/functions.ts`. Inngest functions must be idempotent — use `computeEventHash` for deduplication.

### New Connector

Add to `packages/ingestion/src/connectors/<name>/index.ts`. Implement:
- `verifyWebhook(req, secret)` — HMAC or connector-specific verification
- `normalizeRecord(raw)` — map raw API response to `NormalizedRecord`
- `previewRecordTypes()` — available record type definitions

Register in `packages/ingestion/src/connectors/types.ts`.

## Testing Standards

- **New code requires new tests.** Handlers, utilities, routes — all need unit tests.
- **Coverage thresholds are ratchets** — only increase, capped at 90, never decrease.
- **E2E tests** for any new user-facing flow in `apps/app/e2e/`. Use Playwright fixtures from `e2e/helpers/`.
- **Screenshots required** for UI changes: e2e tests must capture key success states.
- Threshold headroom rule: bump only when `floor(new_coverage - 2.5) > current_threshold`.

## Coding Standards

- **TypeScript strict mode** — no `any`, no `// @ts-ignore` without a comment
- **Zero ESLint warnings** — `eslint-disable` requires an inline justification comment
- **Zod for all external boundaries** — API inputs, env vars, capability contracts
- **Tenancy seam**: every DB query inside a scoped capability must run inside `runInTenantScope`
- **No cross-domain FKs inside schema builders** — use Drizzle relations in `src/relations.ts`
- **Storage boundaries**: see `AGENTS.md` — Postgres / Neo4j / ClickHouse domains are hard boundaries

## Database Migration Rules

- **Target check**: echo the DB URL before any mutation script; local = `localhost:5433`
- **`unset DATABASE_URL`** before running local scripts if a shell `DATABASE_URL` might override
- **Verify with a query after migration** — don't trust logs alone
- Atlas migration files must pass `pnpm db:lint-migrations` and `pnpm db:atlas-validate`

## Git Workflow

`main` is a shared, contested branch worked in parallel by multiple agents, and the
pre-push hook runs the affected unit-test suite as a gate. To keep those test runs
from stacking, **work on a branch, commit, and never push.**

- **Always start from a fresh, synced `main`:** `git fetch origin`; if `origin/main`
  is ahead, `git switch main && git rebase origin/main` (resolve conflicts) before
  cutting your branch.
- **Cut a branch (or `git worktree`) for the work** — use a worktree for any large body
  of work: `git worktree add ../oxagen-<slug> -b <branch>`.
- **Run `pnpm gate`, then commit and stop.** Leave the work committed but unpushed;
  Mac performs every push himself, one at a time. This is a hard rule — never run
  `git push` yourself unless explicitly told to in-session.
- Commit messages: imperative mood, under 72 chars (`Add capability: agent.code.execute`)
- Never commit or push with `--no-verify`.

## Dependency Management

- Add deps to the specific `package.json` that imports them, not the monorepo root
- Run `pnpm i --no-frozen-lockfile` after any dep change
- Use exact or tightly pinned versions for new dependencies
- Check `pnpm-workspace.yaml` overrides before adding a dep that may conflict

## Environment Variables

All env vars must be declared in `packages/config/src/registry.ts` with Zod validation. After adding a new var:
1. Add to `packages/config/src/registry.ts`
2. Add to `.env.example`
3. Run `pnpm env:check` to verify

## Release Process

Only for maintainers:

```bash
pnpm release:patch    # bug fixes
pnpm release:minor    # new features
pnpm release:major    # breaking changes
```

This bumps all package versions, deploys to Vercel, publishes CLI to npm, and generates release notes.
