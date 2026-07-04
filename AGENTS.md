# AGENTS.md

**Mission: Oxagen is the metered, governed, graph-grounded control plane for teams that build and resell AI agents — the neutral Stripe-for-agents.** [`docs/VISION.md`](docs/VISION.md) is the north star for every feature decision; CI's Vision Gate (`pnpm check:vision`) judges every PR diff against it.

Enterprise AI platform. Monorepo. Built around one primitive: a **capability kernel** that every surface (API, MCP, web app, CLI) calls through a single `invoke()` function — which is where governance (IAM + entitlement), metering (ClickHouse→Stripe), and lineage are enforced.

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
| `cli` | `apps/cli/src/index.tsx` | Commander + Ink CLI; command modules in `src/commands/` (count drifts — don't hard-code it) |
| `docs` | `apps/docs/src/` | Fumadocs documentation site |
| `schemas` | `apps/schemas/` | Static JSON Schema hosting (schemas.oxagen.sh), generated from canonical Zod schemas |
| `web` | `apps/web/` | oxagen.sh public website |

### Core Packages

| Package | Key File | Purpose |
|---|---|---|
| `oxagen` | `src/kernel.ts` | Capability kernel — the one `invoke()` path |
| `oxagen` | `src/contracts/` | ~173 capability contracts (Zod schemas + metadata) |
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

`.github/workflows/pipeline.yml` runs: lint → typecheck → unit tests → build → `check:manifest` → `check:contracts` → `db:lint-migrations`. Gate mirrors this exactly. `vision-gate.yml` additionally LLM-judges the PR diff against `docs/VISION.md` (advisory).

## Git Workflow

`main` is shared and contested — never commit or push to it directly. Cut a branch from a fresh, synced `main`, push it immediately, commit and push frequently, and open a PR against `main`. Tests run in CI on every push/PR, not in git hooks. Full workflow: [`CONTRIBUTING.md`](CONTRIBUTING.md).

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

### UI Component Import Convention

**Never import `@oxagen/ui/components/*` directly in app code.** All frontend apps (`apps/app`, `apps/admin`, `apps/website`, `apps/docs`) must import UI components through their local re-export layer at `src/components/ui/<name>.tsx`.

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