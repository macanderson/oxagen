# AGENTS.md

Enterprise AI platform. Monorepo. Built around one primitive: a **capability kernel** that every surface (API, MCP, web app, CLI) calls through a single `invoke()` function.

## Layout

```
apps/       customer-facing applications
packages/   shared platform libraries (single source of truth for platform code)
tools/      dev tooling (scripts, env-manager)
docs/       capability specs, ADRs, architecture docs
```

### Apps

| App | Entry | Purpose |
|---|---|---|
| `api` | `apps/api/src/app.ts` | Hono HTTP API + Inngest webhook handler |
| `app` | `apps/app/src/app/` | Next.js 16 enterprise web app (App Router) |
| `mcp` | `apps/mcp/src/` | MCP server exposing all platform capabilities as tools |
| `cli` | `apps/cli/src/index.tsx` | Commander + Ink CLI, 108 command files |
| `docs` | `apps/docs/src/` | Fumadocs documentation site |

### Core Packages

| Package | Key File | Purpose |
|---|---|---|
| `oxagen` | `src/kernel.ts` | Capability kernel — the one `invoke()` path |
| `oxagen` | `src/contracts/` | ~140 capability contracts (Zod schemas + metadata) |
| `oxagen` | `src/iam/resolve.ts` | IAM policy resolution |
| `handlers` | `src/register.ts` | All built-in capability handler registrations |
| `agent` | `src/runtime/materialize-tools.ts` | Agent tool list builder |
| `database` | `src/schema/` | 16 Drizzle Postgres schemas |
| `inngest-functions` | `src/functions/` | Durable background jobs |
| `ingestion` | `src/pipeline.ts` | Universal connector pipeline |
| `billing` | `src/metering.ts` | Credit gate + usage metering |
| `plugins` | `src/entitlements/` | Plugin entitlement gate |

## Capability System

Every feature is a **capability** with a unique dot-notation name (e.g. `chat.message.send`).

**Adding a capability** — three required files:
1. `packages/oxagen/src/contracts/<name>.ts` — `defineContract({ name, input, output, surfaces, defaultRoles, ... })`
2. `packages/oxagen/src/contracts/index.ts` — add barrel import
3. `packages/handlers/src/<name>.ts` — handler implementation + registration in `register.ts`

Then wire it into MCP (`apps/mcp/src/tools/<name>.ts`) and CLI (`apps/cli/src/commands/<name>.ts`) if needed.

**Capabilities expose on surfaces**: `api`, `mcp`, `agent`, `cli`. Default: `["api", "mcp"]`.

**Gate injection** (set once at surface bootstrap):
- `setKernelIAMRuntime(checkFn, enforced)` — IAM
- `setBillingAdmissionGate(gate)` — credit check
- `setCapabilityEntitlementGate(gate)` — plugin entitlement

## Storage Boundaries

| Store | Use for | Never use for |
|---|---|---|
| PostgreSQL | Transactional state, users, orgs, billing, IAM, config | Analytics, graph relationships |
| Neo4j | Entities, relationships, execution lineage, agent memory | Transactional state, counters |
| ClickHouse | Audit events, token usage, telemetry (append-only) | Mutable state, graph data |

Cross-domain Postgres queries use `src/relations.ts` (Drizzle). Never write raw cross-schema JOINs inside handlers.

## Repo-Specific Tooling

| Command | What it does |
|---|---|
| `pnpm gate` | Full verification: lint + typecheck + unit tests + build + manifest check + contracts + env check + db lint + atlas validate |
| `pnpm check:manifest` | Enforces API ↔ MCP capability parity (`tools/scripts/check_manifest.mjs`) |
| `pnpm check:contracts` | Ensures every contract file is in the barrel index |
| `pnpm env:check` | Validates `.env.local` against the env registry |
| `pnpm db:lint-migrations` | Verifies Atlas migration file integrity |
| `pnpm db:atlas-validate` | Validates Atlas schema against current DB state |
| `pnpm release:patch/minor/major` | Version bump + Vercel deploy + NPM publish + release notes |

## Key Patterns

- **Tenant scope**: every DB query inside a scoped capability runs inside `runInTenantScope({ orgId, workspaceId })` from `packages/tenancy`. Missing this causes a `TenantScopeError` at runtime.
- **Handler registration**: handlers are lazy-loaded. `registerHandler(name, () => import('./handler').then(m => m.handler))` in `register.ts`. Never eagerly import heavy deps in the kernel.
- **IAM default**: `defaultEffect: "deny"` unless explicitly set to `"allow"`. Admin-only capabilities should set `sensitivity: "high"` and `defaultRoles: { org: { Owner: "allow", Admin: "allow" } }`.
- **`noBillingGate: true`**: set on management/settings capabilities that don't consume AI credits.
- **Test reset**: use `clearHandlersForTests()`, `clearRegistryForTests()`, `clearBillingAdmissionGate()` in test `beforeEach`. All are exported from `packages/oxagen`.
- **Coverage ratchet**: thresholds only go up, capped at 90. Never reduce a threshold.
- **Lint**: zero warnings. `eslint-disable` requires inline comment explaining why.

## CI Config

`.github/workflows/pipeline.yml` runs: lint → typecheck → unit tests → build → `check:manifest` → `check:contracts` → `db:lint-migrations`. Gate mirrors this exactly.

## Documentation

| Path | Content |
|---|---|
| `.agents/summary/index.md` | Full documentation index with routing guide |
| `.agents/summary/architecture.md` | Kernel, surfaces, gate injection, storage boundaries |
| `.agents/summary/components.md` | Every package/app explained with key files |
| `.agents/summary/interfaces.md` | Type signatures, HTTP routes, MCP protocol |
| `.agents/summary/data_models.md` | All 16 Postgres schemas, Neo4j model, billing model |
| `.agents/summary/workflows.md` | Chat turn, ingestion, IAM, billing, release, GDPR |
| `docs/capabilities/_index.md` | All 140+ capability docs |
| `docs/adr/` | Architecture Decision Records |
| `CLAUDE.md` | Engineering operating rules (prime directive, test gate, CI policy) |

## Custom Instructions

<!-- This section is for human and agent-maintained operational knowledge.
     Add repo-specific conventions, gotchas, and workflow rules here.
     This section is preserved exactly as-is when re-running codebase-summary. -->
