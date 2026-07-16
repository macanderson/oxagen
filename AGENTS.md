# AGENTS.md

Oxagen is a metered, governed, graph-grounded control plane for teams that build and resell AI agents. [`docs/VISION.md`](docs/VISION.md) is the reference for feature direction; CI's Vision Gate (`pnpm check:vision`) judges every PR diff against it.

Monorepo built around one primitive: a **capability kernel** that every surface (API, MCP, web app, CLI) calls through a single `invoke()` function — where governance (IAM + entitlement), metering (ClickHouse→Stripe), and lineage are enforced.

## Layout

```
apps/       customer-facing applications (7: api, app, cli, docs, mcp, schemas, web)
packages/   shared platform libraries (32 packages — single source of truth for platform code)
tools/      dev tooling (scripts, env-manager)
docs/       capability specs, ADRs, architecture docs
```

### Apps

| App | Entry | Purpose |
|---|---|---|
| `api` | `apps/api/src/app.ts` | Hono HTTP API + Inngest webhook handler |
| `app` | `apps/app/src/app/` | Next.js 16 enterprise web app (App Router) |
| `mcp` | `apps/mcp/src/` | MCP server exposing all platform capabilities as tools |
| `cli` | `apps/cli/src/index.tsx` | Commander + Ink CLI; command modules in `src/commands/` (count drifts — don't hard-code it) |
| `docs` | `apps/docs/src/` | Fumadocs documentation site |
| `schemas` | `apps/schemas/` | Static JSON Schema hosting (schemas.oxagen.sh), generated from canonical Zod schemas |
| `web` | `apps/web/` | oxagen.sh public website |

### Core Packages

| Package | Key File | Purpose |
|---|---|---|
| `oxagen` | `src/kernel.ts` | Capability kernel — the one `invoke()` path |
| `oxagen` | `src/contracts/` | ~349 registered capabilities (count drifts; Zod schemas + metadata) |
| `oxagen` | `src/iam/resolve.ts` | IAM policy resolution |
| `oxagen` | `src/registry.ts` | Capability registry (`registerCapability`, `getCapability`) |
| `oxagen` | `src/plugins/` | Plugin manifest registry + built-in plugin catalogs |
| `handlers` | `src/register.ts` | All built-in capability handler registrations (lazy-loaded) |
| `agent` | `src/runtime/materialize-tools.ts` | Agent tool list builder, MCP server auth, sandbox session management |
| `agent` | `src/handlers/` | Agent capability handlers (sandbox, memory, subagent, MCP, triggers) |
| `agent-engine` | `src/engine.ts` | Agent execution engine (tool loop, pipeline, spec/oracle/evaluate) |
| `database` | `src/schema/` | 25 Drizzle Postgres schema files (20 domain + `_mixins`/`_schemas`/`index`/etc.) |
| `inngest-functions` | `src/functions/` | Durable background jobs |
| `ingestion` | `src/pipeline.ts` | Universal connector pipeline |
| `billing` | `src/metering.ts` | Credit gate + usage metering |
| `billing` | `src/grants.ts` | Credit grants + scope |
| `plugins` | `src/entitlements/` | Plugin entitlement gate + bootstrap |
| `plugins` | `src/oauth/` | OAuth provider detection, state store, preregistered clients |
| `plugins` | `src/credentials/` | Workspace credential management + KMS |
| `tenancy` | `src/scope.ts` | `runInTenantScope`, `runWithPrincipal`, tenant context |
| `telemetry` | `src/clickhouse.ts` | ClickHouse client + migration runner |
| `telemetry` | `src/circuit-breaker.ts` | Circuit breaker for telemetry clients |
| `auth` | | Better Auth integration (sessions, rate limits, org members) |
| `iam` | | IAM schema, roles, permissions, policy seeding |
| `ontology` | | Neo4j ontology contracts + graph queries |
| `engram` | | Agent memory engram writer/bootstrap |
| `storage` | `src/vercel-blob.ts` | Vercel Blob + filesystem blob driver |
| `sandbox` | `src/vercel.ts` | Sandbox drivers: Docker, Modal, Vercel |
| `skills` | `src/loader.ts` | Built-in agent skill loading + filesystem |
| `prompt-templates` | `src/templates/` | YAML prompt templates for agent workflows |
| `replay` | `src/recorder.ts` | Session recording, restore, bisect |
| `bench` | | Benchmark harness (ingest, query, replay) |
| `code-graph` | | Code relationship graph for CLI agent context |
| `config` | | Shared configuration schema + resolution |
| `crypto` | | Encryption utilities |
| `github` | | GitHub App integration |
| `mcp-config` | | MCP server configuration |
| `notifications` | | Notification dispatch |
| `compliance` | | Audit coverage + security event types |
| `web` | `src/fetch.ts` | Web fetch + search utilities |
| `ui` | | Shared component library (`@oxagen/ui`) |

## Capability System

Every feature is a **capability** with a unique verb-first snake_case name (e.g. `send_message`) — ADR-025 retired the old dotted `domain.subject.action` form with **no alias fallback**; contract/route/tool/doc *file* renames are a separate, still-in-progress "file-path realignment phase" (see `docs/specs/adr025-naming-mapping.md`), so many source files still use the old dotted stem even though the registered `name` is verb-first snake_case.

**Adding a capability** — three required files:
1. `packages/oxagen/src/contracts/<name>.ts` — `registerCapability({ name, input, output, surfaces, layers, defaultRoles, ... })`
2. `packages/oxagen/src/contracts/index.ts` — add barrel import
3. `packages/handlers/src/<name>.ts` — handler implementation + registration in `register.ts`

Then wire it into MCP (`apps/mcp/src/tools/<name>.ts`) and CLI (`apps/cli/src/commands/<name>.ts`) if needed.

**Capabilities expose on surfaces**: `api`, `mcp`, `agent`, `cli`. Default: `["api", "mcp"]`.

**The `layers[]` field** is separate from `surfaces[]` — it tracks which artifacts exist for the capability: `schema`, `api`, `mcp`, `cli`, `agent`, `unit` (test), `e2e`, `docs`, `app`. The `check:manifest` and `check:ui-parity` scripts use `layers[]` to verify parity.

**The `agent` metadata field** on contracts controls agent-facing behavior: `{ requiresApproval, riskLevel, category }`. Capabilities with `requiresApproval: true` pause for human approval before executing.

**The `mode` field** is `"sync"` (default) or `"async"`. Async capabilities dispatch long-running work (via Inngest) and return immediately with a status/render payload.

**The `scoped` field** (boolean) indicates whether the capability runs inside `runInTenantScope`. Scoped capabilities require valid `orgId` + `workspaceId` UUIDs.

**Generative UI output**: handlers can return a `render` object (`{ componentId, props }`) in their output. The client maps `componentId` to a React component via the chat component registry. No server-rendered React trees — `generateObject` structured output only.

**Gate injection** (set once at surface bootstrap):
- `setKernelIAMRuntime(checkFn, enforced)` — IAM
- `setBillingAdmissionGate(gate)` — credit check (fires after IAM, before handler; `noBillingGate: true` skips)
- `setCapabilityEntitlementGate(gate)` — plugin entitlement (fires after billing; only for plugin-claimed contracts)

**Handler registration** — handlers are lazy-loaded via `registerHandler(name, () => import('./handler').then(m => m.handler))` in `register.ts`. The entire file is wrapped in `registerHandlersOnce("@oxagen/handlers", () => { ... })` to prevent duplicate-registration on hot reload. **Critical gotcha**: the registered capability `name` (verb-first snake_case) often differs from the handler filename (old dotted stem) — e.g. `workflow.run.ts` registers `"run_workflow"`. Always check the contract's `name` field, not the filename.

Never eagerly import heavy deps in the kernel — `import "@oxagen/handlers/register"` before any `invoke()` call; forgetting silently no-ops metering/IAM.

## Storage Boundaries

| Store | Use for | Never use for |
|---|---|---|
| PostgreSQL | Transactional state, users, orgs, billing, IAM, config | Analytics, graph relationships |
| Neo4j | Entities, relationships, execution lineage, agent memory | Transactional state, counters |
| ClickHouse | Audit events, token usage, telemetry (append-only) | Mutable state, graph data |
| Blob (Vercel Blob / FS) | Binary assets, avatars, generated images/documents | Transactional state, metadata |

Cross-domain Postgres queries use `src/relations.ts` (Drizzle). Never write raw cross-schema JOINs inside handlers.

**Connector Dual-Write exception**: Data connectors write to Postgres (operational record, ACID) and Neo4j (graph index, async Inngest). ClickHouse observes ingestion events for telemetry.

## Repo-Specific Tooling

| Command | What it does |
|---|---|
| `pnpm dev` | Start all apps + Docker (Postgres :5433, ClickHouse :8123, Neo4j :7687) |
| `pnpm kill` | Kill all background dev processes |
| `pnpm gate` | Full verification: lint + typecheck + unit tests + build + manifest + contracts + ui-parity + mobile-parity + env check + db lint + atlas validate |
| `pnpm build` | Full monorepo build via Turborepo |
| `pnpm lint` | ESLint across all packages (zero warnings enforced) |
| `pnpm format` | Biome format (ADR-015; Biome is the sole formatter) |
| `pnpm typecheck` | TypeScript check across monorepo |
| `pnpm check:manifest` | Enforces API ↔ MCP capability parity (`tools/scripts/check_manifest.mjs`) |
| `pnpm check:manifest --json` | Machine-readable parity output (filter for genuine `api`/`mcp` gaps) |
| `pnpm check:ui-parity` | Enforces app-layer capability → UI binding (`capability-ui-map.json`) |
| `pnpm check:mobile-parity` | Enforces mobile feature parity (ADR-026) — no desktop-only features without registered reflow/hidden justification |
| `pnpm check:connector-schemas` | Verifies all 16 built-in plugin connector schemas are registered |
| `pnpm check:contracts` | Ensures every contract file is in the barrel index + naming compliance |
| `pnpm check:vision` | LLM-judges PR diff against `docs/VISION.md` |
| `pnpm env:check` | Validates `.env.local` against the env registry |
| `pnpm db:migrate` | Apply pending Postgres migrations + seed platform data |
| `pnpm db:lint-migrations` | Verifies Atlas migration file integrity |
| `pnpm db:atlas-validate` | Validates Atlas schema against current DB state |
| `pnpm db:seed-iam` | Seed IAM roles and permissions |
| `pnpm db:seed-skills` | Seed agent skill definitions |
| `pnpm release:patch/minor/major` | Lockstep version bump (all packages) + AI-generated release notes (via Vercel AI Gateway) + git tag + Vercel `PLATFORM_VERSION` sync + optional NPM publish |
| `pnpm test:e2e` | Run Playwright e2e tests (`apps/app`) |

**Narrow test runs** (never run all tests): `pnpm --filter @oxagen/<pkg> test:unit -- <file>.test.ts`

**Gate gotcha**: `pnpm gate` runs turbo with `--filter=...[origin/main]`, so it only executes against packages changed since `origin/main`. If `HEAD == origin/main` (e.g. verifying a clean tree), turbo finds zero affected packages and the gate appears to pass without running anything. To force a full run, use `turbo run lint typecheck test:unit test:coverage build` directly.

**Test parallelism**: running all test packages in parallel (`turbo run test:unit`) can cause resource-contention failures on a local machine — large packages (app, cli, handlers, agent) OOM or timeout under concurrent load. Use `turbo run test:unit --concurrency=1` or `TURBO_CONCURRENCY=1 pnpm gate` for reliable local runs.

**Release script flags**: `tsx tools/scripts/release.ts major --dry-run` (preview without writing), `--set X.Y.Z` (exact version), `--no-vercel` / `--no-npm` / `--no-git` / `--no-notes` (skip individual steps), `--from <ref>` (regenerate notes for an existing tag).

## Key Patterns

- **Tenant scope**: every DB query inside a scoped capability runs inside `runInTenantScope({ orgId, workspaceId })` from `packages/tenancy`. Missing this causes a `TenantScopeError` at runtime. Use `withTenantDb((tx) => ...)` for scoped Postgres access; `withSystemDb` for cross-tenant/system queries. Raw `db()` is banned.
- **IAM default**: `defaultEffect: "deny"` unless explicitly set to `"allow"`. Admin-only capabilities should set `sensitivity: "high"` and `defaultRoles: { org: { Owner: "allow", Admin: "allow" } }`.
- **`noBillingGate: true`**: set on management/settings capabilities that don't consume AI credits.
- **Test reset**: use `clearHandlersForTests()`, `clearRegistryForTests()`, `clearBillingAdmissionGate()` in test `beforeEach`. All are exported from `packages/oxagen`.
- **Coverage ratchet**: thresholds only go up, capped at 90. Never reduce a threshold. Keep at least 2.5% headroom below actual coverage.
- **Lint**: zero warnings. `eslint-disable` requires inline comment explaining why.
- **LLM calls**: all LLM calls must go through `@oxagen/ai` (re-exports `streamText`/`generateText`/`generateObject`/`embed`). Never import directly from `ai`. The `@oxagen/ai` layer emits metering, duration tracking, surface tagging, and prompt hashing to ClickHouse. Use `modelIdOf()` for model resolution — never hard-code slugs.
- **`bootstrapEntitlementRuntime()`** must be called at startup of any new runtime that invokes capability-gated handlers; forgetting silently skips the entitlement gate.

## Local Development

**Docker via Colima** (macOS): `colima start` before `pnpm dev`. The Docker socket is at `~/.colima/default/docker.sock`. If `docker ps` fails with "Cannot connect to the Docker daemon", restart Colima: `colima stop && colima start`.

**Docker services** (`docker-compose.dev.yml`): Postgres 16 (`:5433`, user/pass `oxagen`/`oxagen`), Neo4j 5.24 (`:7474` UI, `:7687` Bolt`, pass `oxagen-dev`), ClickHouse 24.8 (`:8123` HTTP, `:9000` native`). Host port 5433 avoids collision with a system Postgres on 5432.

**Migration targeting**: `tsx --env-file=.env.local` does NOT override a shell-exported `DATABASE_URL`. Always `unset DATABASE_URL` before targeting local vs prod. Migration files go in `packages/database/atlas/migrations/`, never in `apps/`. After editing migration files, regenerate the checksum: `atlas migrate hash --dir "file://packages/database/atlas/migrations"` from the `packages/database` directory. Echo the target DB URL before any mutation script to confirm you're hitting the right database.

**App ports**: `apps/app` → `:3000`, `apps/docs` → `:3300`, API → `:4000`, MCP → `:4100`.

**Login**: Email+password only (no email verification locally). New user → `/signup` → `/new-organization` → create org → `/{org}/{ws}/ask`. Returning: `/login`.

## CI Config

`.github/workflows/pipeline.yml` runs: lint → typecheck → unit tests → build → `check:manifest` → `check:contracts` → `db:lint-migrations`. Gate mirrors this exactly. `vision-gate.yml` additionally LLM-judges the PR diff against `docs/VISION.md` (advisory). CI runs inside `ghcr.io/oxageninc/oxagen-ci-*` containers with Atlas baked in.

**Pre-commit hooks** (lefthook): Biome format (staged files), ESLint fix (staged files), staged-file typecheck via `tools/scripts/typecheck-staged.mjs`, atlas-validate (only when migration files are staged). **Pre-push hooks**: `check:contracts` + `env:check` only — no test suites (those run in CI).

## Git Workflow

`main` is shared and contested — never commit or push to it directly. Cut a branch from a fresh, synced `main`, push it immediately, commit and push frequently, and open a PR against `main`. Tests run in CI on every push/PR, not in git hooks. Full workflow: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Documentation

| Path | Content |
|---|---|
| `.agents/summary/index.md` | Full documentation index with routing guide |
| `.agents/summary/architecture.md` | Kernel, surfaces, gate injection, storage boundaries |
| `.agents/summary/components.md` | Every package/app explained with key files |
| `.agents/summary/interfaces.md` | Type signatures, HTTP routes, MCP protocol |
| `.agents/summary/data_models.md` | All Postgres schemas, Neo4j model, billing model |
| `.agents/summary/workflows.md` | Chat turn, ingestion, IAM, billing, release, GDPR |
| `docs/capabilities/_index.md` | Index of capability doc files |
| `docs/adr/` | Architecture Decision Records |
| `CLAUDE.md` | Engineering operating rules (prime directive, test gate, CI policy) |

## Custom Instructions

<!-- This section is for human and agent-maintained operational knowledge.
     Add repo-specific conventions, gotchas, and workflow rules here.
     This section is preserved exactly as-is when re-running codebase-summary. -->

### UI Component Import Convention

**Never import `@oxagen/ui/components/*` directly in app code.** All Next.js apps (`apps/app`, `apps/docs`, …) must import UI components through their local re-export layer at `src/components/ui/<name>.tsx`. (`apps/admin` and `apps/website` do not exist in this monorepo — the 7 apps are `api`, `app`, `cli`, `docs`, `mcp`, `schemas`, `web`.)

```ts
// ✅ Correct — uses the app's re-export layer
import { Button } from "@/components/ui/button";

// ❌ Forbidden — bypasses the indirection
import { Button } from "@oxagen/ui/components/button";
```

**Why:** The re-export layer is a cheap override escape hatch. If a shared component ever needs an app-specific wrapper (e.g. injecting Next.js `Link`, adding a context provider), you swap the one-liner in `src/components/ui/button.tsx` for a local wrapper — zero consumers change. Direct imports bypass this.

**Exceptions:** The re-export files themselves (`src/components/ui/*.tsx`) legitimately import from `@oxagen/ui/components/*`. Importing `@oxagen/ui` (barrel), `@oxagen/ui/styles/*`, and `@oxagen/ui/lib/*` is allowed everywhere.

**Enforcement:** `no-restricted-imports` rule in `eslint.next.mjs` — errors on any `@oxagen/ui/components/*` import outside the `src/components/ui/` layer.

### UI Component Test Placement

Tests for shared components (`@oxagen/ui`) live in `packages/ui/src/components/<name>.test.tsx`. Tests for app-specific UI components (e.g. `breadcrumb`, `page-header`, `page-tabs`, `field-fill-transition`) stay in `apps/app/src/components/ui/`.

**Rule of thumb:** if the component's source is a re-export (`export * from "@oxagen/ui/components/..."`) → the test belongs in `packages/ui`. If the component is an original implementation that lives only in the app → the test stays in the app.

### Design Token Usage in Shell Components

Shell chrome components (`shell-frame`, `sidebar`, `sidebar-item`, `mobile-bottom-bar`, `notifications-bell`, `balance-pill`, `support-menu`, `user-switcher`) must use the component-level design tokens from `packages/ui/src/styles/globals.css`, not the generic base tokens.

| Area | Use these tokens | Not these |
|---|---|---|
| Content panel | `bg-app-panel-bg`, `text-app-panel-fg` | `bg-background`, `text-foreground` |
| Topbar / header | `bg-app-topbar-bg`, `text-app-topbar-fg`, `border-app-topbar-border` | `bg-background`, `border-border` |
| App chrome links | `text-app-link-fg`, `hover:text-app-link-hover-fg`, `text-app-link-active-fg` | `text-muted-foreground`, `text-foreground` |
| Sidebar surface | `bg-sidebar-bg`, `text-sidebar-fg` | `bg-sidebar`, `text-sidebar-foreground` |
| Sidebar nav items | `text-sidebar-nav-link-fg`, `hover:bg-sidebar-nav-link-hover-bg`, etc. | `text-sidebar-foreground`, `hover:bg-sidebar-accent` |
| Sidebar group labels | `text-sidebar-nav-label-fg` | `text-muted-foreground` |

**Why:** Component tokens are the reskin knobs. A designer changes `--app-topbar-bg` once in `globals.css` and every header in every shell file re-skins. Using generic tokens (`bg-background`) defeats this — you'd have to touch every component file.
