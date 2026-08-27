# Contributing

Oxagen is the metered, governed, graph-grounded control plane for teams that build and resell AI agents. Every contribution is judged against that vision — read [`docs/VISION.md`](docs/VISION.md) before proposing a feature. CI runs a **Vision Gate** (`pnpm check:vision`) that LLM-judges every PR diff against it; routine fixes, tests, and tooling are neutral by definition, but strategic drift gets flagged.

## Prerequisites

- Node.js 24+ (`node -v`)
- pnpm 11+ (`npm i -g pnpm`) — the repo pins `pnpm@11.7.0` via `packageManager`
- Docker (for local Postgres :5433, Neo4j :7687, ClickHouse :8123)

## First-Time Setup

```bash
cp .env.example .env.local   # fill in required values
pnpm install
pnpm env:check               # validate .env.local
pnpm dev                     # starts Docker + migrations + all apps
```

## Git Workflow — branch early, push often, open a PR

`main` is a shared, contested branch worked in parallel by multiple humans and coding agents. **Never commit or push directly to `main`.** Test suites run in CI on every push and PR (not in git hooks), so pushing is cheap — push early and often.

1. **Start from a fresh, synced `main`:** `git fetch origin`; if `origin/main` is ahead, `git switch main && git rebase origin/main` (resolve conflicts) before cutting your branch.
2. **Cut a branch and push it immediately:** `git switch -c <type>/<slug> && git push -u origin <type>/<slug>`. Use a `git worktree` for any large body of work: `git worktree add ../oxagen-<slug> -b <branch>`.
3. **Commit frequently, push regularly.** Small increments at every meaningful step. A pushed work-in-progress branch beats a perfect change sitting on your disk.
4. **Open a PR against `main`** — a draft early on is fine. The PR is where CI runs the full gate and where the work gets reviewed and merged.
5. **Before marking the PR ready:** run `pnpm gate` locally, push, and confirm CI green (`gh run watch`).

Other rules:

- Commit messages: imperative mood, under 72 chars (`Add capability: execute_code`) — dotted capability names are retired (ADR-025).
- Don't rebase, squash, or cherry-pick to "tidy" shared history — correct, complete, pushed work beats a pretty history.
- Everything committed must be **functionally complete**: fully wired end-to-end, every layer present, tests passing, no dead code.

## Before Marking a PR Ready

**The gate must pass:**

```bash
pnpm gate     # lint + typecheck + tests + build + manifest + contracts + env + db
```

If `gate` fails on any step, fix it before requesting review. The CI gate is identical, plus the Vision Gate.

## Adding a Feature

### New Capability

Every user-facing action is a **capability**: a typed contract exposed with parity across API, MCP, CLI, and UI. The correct order is always contract → API route → MCP tool → UI/CLI wire-up — never wire a UI surface to live data before the contract exists.

1. Define the contract in `packages/oxagen/src/contracts/<name>.ts`
2. Add the barrel import to `packages/oxagen/src/contracts/index.ts` — note `tools/scripts/check_manifest.mjs` also auto-generates `contracts.generated.ts` from the contracts directory, but the hand-maintained `index.ts` barrel remains the authoritative one consumed by the rest of the codebase
3. Implement the handler in `packages/handlers/src/<name>.ts`
4. Register it in `packages/handlers/src/register.ts`
5. Add the API route in `apps/api/src/routes/v1/<capability>.ts`
6. If exposing on MCP: add `apps/mcp/src/tools/<name>.ts`
7. If exposing on CLI: add `apps/cli/src/commands/<name>.ts`
8. Add the capability doc in `docs/capabilities/<name>.md` and update `_index.md`
9. Write unit tests — coverage must meet the package threshold
10. Run `pnpm check:manifest` to verify parity

Contract fields that require careful thought:

- `defaultEffect`: use `"deny"` for most capabilities; `"allow"` only for truly public reads
- `sensitivity`: drives IAM audit logging and default grant decisions
- `noBillingGate`: set to `true` for management/settings ops that don't consume AI credits
- `defaultRoles`: seed IAM grants — these become the defaults in `seed-iam-defaults.ts`

Vision-alignment requirements for every new capability:

- **Metered** — it dispatches through `invoke()` so usage events land in ClickHouse. No unmetered side doors.
- **Governed** — IAM + entitlement gates apply; no `"just this once"` untyped/ungated paths.
- **Grounded** — if it surfaces agent output where graph grounding applies, the output cites nodes/edges (see the citation components in `apps/app/src/components/knowledge/graph/`).
- **Vendor-neutral** — model access through `@oxagen/ai` and `modelIdOf()`; never import `generateText`/`streamText`/`generateObject` directly from `ai` in a handler or route, and never hard-code a model slug.

### New Postgres Schema

Schemas go in `packages/database/src/schema/`. Use the existing `pgSchema()` pattern:

```typescript
import { someSchema } from "./_schemas";
export const myTable = someSchema.table("my_table", { ... });
```

Create the migration:

```bash
pnpm db:migrate:diff     # generates Atlas migration file
pnpm db:lint-migrations  # verify integrity
pnpm db:migrate          # apply locally
```

Never create migration files manually — always use `atlas migrate diff`. Migration files go in `packages/database/atlas/migrations/`, never in `apps/`.

**A migration may not require a superuser.** Production runs on Aurora, where the connecting role gets `rds_superuser` — which creates roles, databases and allowlisted extensions, but is **not** a Postgres superuser and can never be granted `BYPASSRLS`. Postgres gates some statements on the actor holding the real superuser bit whatever the values involved, so these fail `42501` on Aurora while passing on a local container:

| Don't write | Because | Instead |
| --- | --- | --- |
| `ALTER ROLE x NOSUPERUSER` / `NOBYPASSRLS` | gated on the *actor* being a superuser even when the value is unchanged | guard it on `pg_roles` so it is reached only when the role has actually drifted |
| `CREATE FUNCTION … SET my.custom_guc` | persisting a custom GUC on a signature needs the superuser bit (`SET search_path` is fine) | set it in the body with `set_config(…, true)` and restore the caller's prior value before every exit |
| anything assuming `BYPASSRLS` can be granted | Aurora grants it to no role, by any means | test `current_setting('app.rls_bypass', true) = 'on'` in the policy, as the existing tables do |

Both of the first two shipped and passed CI for months before Aurora rejected them (#1333). The `rds-compatibility` job now applies the whole directory from empty as a role with those limits, so it is caught on the pull request rather than on a real cluster — `tools/scripts/rds-sim-check.sh`. It does **not** check extension availability; that still needs a real cluster (#1341).

**Target check before any mutation script:** echo the DB URL first; local = `localhost:5433`. `tsx --env-file=.env.local` does **not** override a shell-exported `DATABASE_URL` — `unset DATABASE_URL` to force local targeting. **Verify with a `SELECT` after migration** — don't trust logs alone.

### New Inngest Function

Add to `packages/inngest-functions/src/functions/`. Register in `src/functions.ts`. Inngest functions must be idempotent — use `computeEventHash` for deduplication.

### New Connector

Add to `packages/ingestion/src/connectors/<name>/index.ts`. Implement:

- `verifyWebhook(req, secret)` — HMAC or connector-specific verification
- `normalizeRecord(raw)` — map raw API response to `NormalizedRecord`
- `previewRecordTypes()` — available record type definitions

Register in `packages/ingestion/src/connectors/types.ts`. Connectors dual-write: Postgres holds the operational record (sync cursor, connection health — source of truth), Neo4j holds the graph index (async via Inngest, retryable), ClickHouse observes ingestion telemetry.

## Testing Standards

- **New code requires new tests.** Handlers, utilities, routes — all need unit tests.
- **Coverage thresholds are ratchets** — only increase, capped at 90, never decrease.
- **E2E tests** for any new user-facing flow in `apps/app/e2e/`. Use Playwright fixtures from `e2e/helpers/`.
- **Screenshots required** for UI changes: e2e tests must capture key success states.
- Threshold headroom rule: bump only when `floor(new_coverage - 2.5) > current_threshold`.
- Run the **narrowest** command that proves your change (`pnpm --filter <pkg> test:unit -- <file>`), not a whole-repo suite — the full gate runs in CI.

## Coding Standards

- **TypeScript strict mode** — no `any`, no `// @ts-ignore` without a comment
- **Zero ESLint warnings** — `eslint-disable` requires an inline justification comment
- **Zod for all external boundaries** — API inputs, env vars, capability contracts
- **Tenancy seam**: every DB query inside a scoped capability must run inside `runInTenantScope`; raw `db()` is banned — use `withTenantDb` / `withSystemDb` / `scopedSession`
- **All LLM calls through `@oxagen/ai`** — never import the `ai` SDK directly in handlers or routes; the re-exports emit metering, duration tracking, and prompt hashing to ClickHouse
- **No cross-domain FKs inside schema builders** — use Drizzle relations in `src/relations.ts`
- **Storage boundaries are hard law**: Postgres = transactional state, Neo4j = graph, ClickHouse = append-only events, blob storage = binaries. See `AGENTS.md` and `docs/adr/`.
- **UI imports**: never import `@oxagen/ui/components/*` directly in app code — use the app's local re-export layer (`@/components/ui/<name>`). Enforced by ESLint.
- **Never display raw node/edge UUIDs in the UI** — cite by human label with an inspectable popover (`NodeRef` and friends).

## Dependency Management

- Add deps to the specific `package.json` that imports them, not the monorepo root
- Run `pnpm i --no-frozen-lockfile` after any dep change to sync the lockfile
- Use exact or tightly pinned versions for new dependencies
- Check `pnpm-workspace.yaml` overrides before adding a dep that may conflict
- Vendor neutrality is a moat: prefer neutral abstractions over vendor-specific SDKs wherever one exists

## Environment Variables

All env vars must be declared in `packages/config/src/registry.ts` with Zod validation. After adding a new var:

1. Add to `packages/config/src/registry.ts`
2. Add to `.env.example`
3. Run `pnpm env:check` to verify

Keep production URLs isolated to env vars — never hard-code domains.

## Release Process

Only for maintainers:

```bash
pnpm release:patch    # bug fixes
pnpm release:minor    # new features
pnpm release:major    # breaking changes
```

This bumps all package versions, deploys to Vercel, publishes the CLI to npm, and generates release notes.

## Security

Never open a public issue for a vulnerability — see [`SECURITY.md`](SECURITY.md) for private reporting channels.
