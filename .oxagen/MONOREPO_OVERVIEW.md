# Oxagen Monorepo Overview

**Version:** 0.5.0
**Last Updated:** June 2024
**Purpose:** Complete reference documentation for agent coders building features on Oxagen

---

## Executive Summary

Oxagen is an **enterprise AI platform** that transforms fragmented business data into a live, queryable knowledge graph, then unleashes intelligent AI agents that enrich, infer, and bind every decision back to auditable evidence.

**Core Architecture Principle:** Every feature is a **capability** with a unique contract, invoked through a single `invoke()` kernel, and exposed identically across all surfaces (API, MCP, Web App, CLI).

---

## Repository Structure

```
oxagen-monorepo/
├── apps/              # Customer-facing applications (5 apps)
│   ├── api/           # Hono REST API + Inngest webhook handler
│   ├── app/           # Next.js 16 interactive web UI (App Router)
│   ├── mcp/           # MCP server (tool protocol)
│   ├── cli/           # Commander + Ink CLI (124 commands)
│   └── docs/          # Fumadocs documentation site
│
├── packages/          # Shared platform libraries (27 packages)
│   ├── oxagen/        # ⭐ KERNEL - Capability registry (383 contracts)
│   ├── handlers/      # Built-in capability implementations
│   ├── agent/         # Agent runtime & tool dispatch
│   ├── database/      # Drizzle + 16 Postgres schemas
│   ├── inngest-functions/  # Durable background jobs
│   ├── ingestion/     # Universal connector pipeline
│   ├── billing/       # Stripe ledger + credit gating
│   ├── iam/           # Identity & access management
│   ├── ontology/      # Neo4j schema + graph queries
│   ├── telemetry/     # ClickHouse event streaming
│   ├── auth/          # Better Auth integration
│   ├── ai/            # Vercel AI SDK helpers
│   ├── config/        # Zod environment registry
│   ├── tenancy/       # Multi-tenant scope enforcement
│   ├── compliance/    # GDPR/privacy controls
│   ├── crypto/        # Encryption utilities
│   ├── engram/        # Context/memory engine (CLI)
│   ├── functions/     # Shared function utilities
│   ├── mcp-config/    # MCP configuration
│   ├── notifications/ # Email/notification system
│   ├── plugins/       # Plugin marketplace system
│   ├── prompt-templates/  # LLM prompt library
│   ├── sandbox/       # Code execution sandboxes
│   ├── skills/        # Agent skill definitions
│   ├── storage/       # Vercel Blob utilities
│   ├── ui/            # Component design system
│   └── web/           # Web utilities
│
├── tools/             # Dev orchestration & automation
│   └── scripts/       # 40+ automation scripts
│
├── docs/              # Specs, ADRs, guides
│   ├── adr/           # Architecture Decision Records (16 ADRs)
│   ├── capabilities/  # Capability documentation
│   ├── guides/        # Developer guides
│   └── specs/         # Epic specifications
│
├── .agents/           # AI agent documentation
├── .github/           # CI/CD workflows
├── .remember/         # Memory/context for AI assistants
└── infra/             # Infrastructure configs
```

---

## Tech Stack

| Layer                | Technology            | Purpose                                    |
| -------------------- | --------------------- | ------------------------------------------ |
| **Frontend**         | Next.js 16 + React 19 | App Router, streaming RSC, Turbopack       |
| **API**              | Hono                  | Type-safe routes, zero-overhead middleware |
| **AI Runtime**       | Vercel AI SDK Core    | Streaming, structured output, multi-model  |
| **Primary Database** | PostgreSQL 16         | ACID transactions, RLS, JSON, CDC          |
| **Knowledge Graph**  | Neo4j 5+              | APOC, vectors, graph traversal             |
| **Analytics**        | ClickHouse            | Append-only events, OLAP queries           |
| **Jobs**             | Inngest               | Durable workflows, retries, scheduling     |
| **Auth**             | Better Auth           | Passkeys, OAuth, role-based access         |
| **Storage**          | Vercel Blob           | Signed URLs, public/private assets         |
| **Language**         | TypeScript 6          | Strict mode, no `any` allowed              |
| **Testing**          | Vitest + Playwright   | Fast unit tests, real browser E2E          |
| **Build**            | Turbo                 | Monorepo caching & task orchestration      |
| **Package Manager**  | pnpm 11               | Efficient, strict dependency isolation     |

---

## Key Concepts

### 1. Capability System

Every feature in Oxagen is a **capability** with:

- Unique dot-notation name (e.g., `chat.message.send`)
- Zod contract defining input/output schemas
- IAM policy (defaultEffect: "allow" or "deny")
- Surfaces it exposes on: `["api", "mcp", "agent", "cli"]`
- Handler implementation in `packages/handlers`

**383 capabilities** currently registered in `packages/oxagen/src/contracts/`

### 2. The Kernel

**Location:** `packages/oxagen/src/kernel.ts`

The single `invoke()` function that:

1. Validates input against the capability contract
2. Checks IAM permissions (if enforced)
3. Gates on billing credits (if enabled)
4. Enforces plugin entitlements
5. Dispatches to registered handler
6. Validates output
7. Logs telemetry to ClickHouse

**Every surface calls through the kernel** - no direct handler access.

### 3. Storage Boundaries (Critical!)

| Store          | Use For                                                  | Never Use For                  |
| -------------- | -------------------------------------------------------- | ------------------------------ |
| **PostgreSQL** | Transactional state, users, orgs, billing, IAM, config   | Analytics, graph relationships |
| **Neo4j**      | Entities, relationships, execution lineage, agent memory | Transactional state, counters  |
| **ClickHouse** | Audit events, token usage, telemetry (append-only)       | Mutable state, graph data      |

**Cross-domain queries:** Use Drizzle relations in `packages/database/src/relations.ts` - never raw JOINs in handlers.

### 4. Tenancy Enforcement

**Critical pattern:** Every DB query inside a scoped capability MUST run inside:

```typescript
import { runInTenantScope } from '@oxagen/tenancy';

await runInTenantScope({ orgId, workspaceId }, async (db) => {
  // queries here are automatically scoped
});
```

Missing this causes `TenantScopeError` at runtime.

---

## Development Workflow

### Initial Setup

```bash
# Clone and configure
git clone <repo> oxagen
cd oxagen
cp .env.example .env.local  # Fill in required values

# Install dependencies
pnpm install

# Validate environment
pnpm env:check

# Start everything (Docker + migrations + all apps)
pnpm dev
```

### Daily Development

```bash
# Watch mode (all apps + Docker)
pnpm dev

# Run tests
pnpm test                # Unit + integration tests
pnpm test:e2e           # E2E tests (Playwright)

# Type checking
pnpm typecheck          # All packages

# Linting
pnpm lint               # ESLint (zero warnings required)

# Database operations
pnpm db:migrate         # Apply pending migrations
pnpm db:seed-iam        # Seed roles + permissions
pnpm db:seed-skills     # Seed agent skills
```

### CLI Development

```bash
# Install CLI globally with live reload
pnpm cli:dev            # Watch + auto-rebuild on change

# One-shot install (no watcher)
pnpm cli:install

# Use the CLI
oxagen --help
oxagen auth whoami
```

### Before Every Push

**The gate MUST pass:**

```bash
pnpm gate
```

This runs:

- ✅ ESLint (zero warnings)
- ✅ TypeScript strict
- ✅ Manifest check (API ↔ MCP parity)
- ✅ Contract check (all contracts in barrel)
- ✅ Unit tests (coverage thresholds)
- ✅ Build (all packages)
- ✅ Migrations (dry-run + lint)
- ✅ Environment validation

### Git Workflow (CRITICAL!)

**Never push directly.** Work on branches:

1. **Start fresh:** `git fetch origin && git rebase origin/main`
2. **Cut a branch:** `git checkout -b feature/your-feature`
3. **Make changes** and commit frequently
4. **Run `pnpm gate`** before final commit
5. **Commit and STOP** - leave unpushed
6. Mac performs all pushes one at a time

**For large work:** Use worktrees:

```bash
git worktree add ../oxagen-feature -b feature/your-feature
cd ../oxagen-feature
# Work here
```

---

## Adding New Features

### New Capability

**Required files:**

1. **Contract:** `packages/oxagen/src/contracts/<name>.ts`

```typescript
import { defineContract } from '../define-contract';
import { z } from 'zod';

export const myCapability = defineContract({
  name: 'my.capability.name',
  input: z.object({
    /* ... */
  }),
  output: z.object({
    /* ... */
  }),
  surfaces: ['api', 'mcp'], // where it's exposed
  defaultEffect: 'deny', // or 'allow'
  sensitivity: 'medium', // 'low', 'medium', 'high'
  noBillingGate: false, // set true for settings/mgmt ops
  defaultRoles: {
    org: { Owner: 'allow', Admin: 'allow' },
    workspace: { Member: 'allow' },
  },
});
```

2. **Barrel export:** Add to `packages/oxagen/src/contracts/index.ts`

```typescript
export * from './my.capability.name';
```

3. **Handler:** `packages/handlers/src/<name>.ts`

```typescript
export async function handler(input: Input): Promise<Output> {
  // Implementation
}
```

4. **Registration:** In `packages/handlers/src/register.ts`

```typescript
registerHandler('my.capability.name', async () => {
  const { handler } = await import('./my-capability-name');
  return handler;
});
```

5. **Tests:** `packages/handlers/src/<name>.test.ts`

**Optional wiring:**

- **MCP:** `apps/mcp/src/tools/<name>.ts` (if exposing via MCP)
- **CLI:** `apps/cli/src/commands/<name>.ts` (if CLI command)
- **API route:** Usually auto-exposed via kernel

**Verification:**

```bash
pnpm check:manifest      # Verify API ↔ MCP parity
pnpm check:contracts     # Verify barrel export
pnpm gate                # Full gate
```

### New Database Schema

**Location:** `packages/database/src/schema/<domain>.ts`

```typescript
import { pgSchema } from 'drizzle-orm/pg-core';
import { someSchema } from './_schemas';

export const myTable = someSchema.table('my_table', {
  // columns
});
```

**Create migration:**

```bash
pnpm db:migrate:diff      # Generate Atlas migration
pnpm db:lint-migrations   # Verify integrity
pnpm db:migrate           # Apply locally
```

**Never create migrations manually** - always use Atlas.

### New Inngest Function

**Location:** `packages/inngest-functions/src/functions/<name>.ts`

```typescript
import { inngest } from '../client';

export const myFunction = inngest.createFunction(
  { id: 'my-function' },
  { event: 'my/event' },
  async ({ event, step }) => {
    // Idempotent implementation
  },
);
```

**Register:** Add to `packages/inngest-functions/src/functions.ts`

### New Connector

**Location:** `packages/ingestion/src/connectors/<name>/`

Implement:

- `verifyWebhook(req, secret)` - HMAC verification
- `normalizeRecord(raw)` - Map to NormalizedRecord
- `previewRecordTypes()` - Available types

**Register:** In `packages/ingestion/src/connectors/types.ts`

---

## Testing Standards

### Coverage Requirements

- **Thresholds are ratchets** - only increase, never decrease
- **Cap at 90%** - diminishing returns above
- **Threshold headroom rule:** Only bump when `floor(new_coverage - 2.5) > current_threshold`

### Test Types

1. **Unit Tests** (`*.test.ts`)
   - Fast, isolated
   - Mock external dependencies
   - Run with `pnpm test`

2. **Integration Tests** (`*.integration.test.ts`)
   - Real database connections
   - Test cross-package interactions
   - Slower but comprehensive

3. **E2E Tests** (`apps/app/e2e/*.spec.ts`)
   - Real browser (Playwright)
   - Full user flows
   - **Screenshots required** for UI changes
   - Run with `pnpm test:e2e`

### Test Patterns

**Setup/Teardown:**

```typescript
import { clearHandlersForTests } from '@oxagen/oxagen';
import { clearBillingAdmissionGate } from '@oxagen/billing';

beforeEach(() => {
  clearHandlersForTests();
  clearBillingAdmissionGate();
});
```

**Tenant Scoping:**

```typescript
import { runInTenantScope } from '@oxagen/tenancy';

await runInTenantScope({ orgId, workspaceId }, async (db) => {
  // Test queries here
});
```

---

## Coding Standards

### TypeScript Rules

- ✅ **Strict mode** - no `any` without comment
- ✅ **No `@ts-ignore`** without inline justification
- ✅ **Zod for boundaries** - API inputs, env vars, contracts
- ✅ **Explicit return types** on public functions

### ESLint Rules

- ⚠️ **Zero warnings** - `eslint-disable` requires comment
- ⚠️ **No restricted imports** - e.g., no direct `@oxagen/ui/components/*`
- ⚠️ **Tenancy seam enforcement** - detects missing RLS

### Component Conventions

**UI Component Imports (Critical!):**

```typescript
// ✅ Correct - use re-export layer
import { Button } from '@/components/ui/button';

// ❌ Forbidden - bypasses indirection
import { Button } from '@oxagen/ui/components/button';
```

**Why:** Re-export layer allows app-specific overrides without changing consumers.

**Design Tokens:** Use component-level tokens in shell components:

```typescript
// ✅ Correct
className = 'bg-app-topbar-bg text-app-topbar-fg';

// ❌ Wrong
className = 'bg-background text-foreground';
```

---

## Database Operations

### Migration Workflow

```bash
# Create a new migration
pnpm db:migrate:diff

# Validate migrations
pnpm db:lint-migrations
pnpm db:atlas-validate

# Apply migrations
pnpm db:migrate

# Seed data
pnpm db:seed-iam         # IAM roles + permissions
pnpm db:seed-skills      # Agent skills
pnpm db:seed-platform    # Platform defaults
```

### Migration Safety Rules

1. **Always check target:** Echo `DATABASE_URL` before mutations
2. **Local only:** Verify URL contains `localhost:5433`
3. **Unset if needed:** `unset DATABASE_URL` if shell var might override
4. **Verify with query:** Don't trust logs - run a SELECT after
5. **Never manual:** Use `atlas migrate diff`, never hand-write migrations

---

## Environment Variables

### Registry-Based Configuration

All env vars MUST be declared in `packages/config/src/registry.ts` with Zod validation.

**Adding a new variable:**

1. Add to registry:

```typescript
export const MY_VAR = defineEnvVar({
  key: 'MY_VAR',
  schema: z.string().min(1),
  description: 'What it does',
  required: true,
});
```

2. Add to `.env.example`
3. Run `pnpm env:check`

### Environment Profiles

- `.env.example` - Template with all vars
- `.env.local` - Local development (gitignored)
- `.env.aws.local` - AWS-specific overrides
- `.env.autonoma.local` - Autonoma-specific

---

## Common Commands Reference

### Development

```bash
pnpm dev                 # Start all apps + Docker
pnpm kill                # Stop everything
pnpm kill -- --volumes   # Full reset (delete volumes)
pnpm clean:cache         # Clear Next.js cache
```

### Testing & Verification

```bash
pnpm gate                # Full CI locally
pnpm test                # Unit tests
pnpm test:e2e            # E2E tests
pnpm typecheck           # TypeScript
pnpm lint                # ESLint
pnpm check:manifest      # API ↔ MCP parity
pnpm check:contracts     # Contract barrel
pnpm check:connector-schemas  # Connector schemas
```

### Database

```bash
pnpm db:migrate          # Apply migrations
pnpm db:migrate:diff     # Create migration
pnpm db:reset            # Reset database
pnpm db:check            # Verify connection
pnpm db:lint-migrations  # Lint migration files
pnpm db:atlas-validate   # Validate Atlas schema
```

### Releases (Maintainers Only)

```bash
pnpm release:patch       # Bug fixes (0.5.0 → 0.5.1)
pnpm release:minor       # Features (0.5.0 → 0.6.0)
pnpm release:major       # Breaking (0.5.0 → 1.0.0)
```

### Utilities

```bash
pnpm env:check           # Validate .env.local
pnpm docs:schemas        # Generate capability docs
lsof -ti:3000            # Check app server
lsof -ti:4000            # Check API server
lsof -ti:4100            # Check MCP server
```

---

## Access Points (Local Development)

| Service       | URL                   | Purpose           |
| ------------- | --------------------- | ----------------- |
| **Web App**   | http://localhost:3000 | Interactive UI    |
| **API**       | http://localhost:4000 | REST endpoints    |
| **MCP**       | http://localhost:4100 | Tool protocol     |
| **Docs**      | http://localhost:3300 | Documentation     |
| **Storybook** | http://localhost:6007 | Component library |

---

## CI/CD Pipeline

**GitHub Actions:** `.github/workflows/pipeline.yml`

**Steps:**

1. Lint (ESLint)
2. Typecheck (TypeScript)
3. Unit tests (Vitest)
4. Coverage enforcement
5. Build (all packages)
6. Manifest check
7. Contract check
8. Migration lint
9. Atlas validate
10. Deploy (Vercel)

**Requirements:**

- ✅ All checks must pass
- ✅ No warnings allowed
- ✅ Coverage thresholds met
- ✅ Manifest in sync
- ✅ Migrations valid

---

## Important Documentation References

### Core Specs

- [README.md](../README.md) - Product overview
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Contribution guide
- [AGENTS.md](../AGENTS.md) - Agent coder quick reference
- [CONTEXT_ENGINE_SPEC.md](../CONTEXT_ENGINE_SPEC.md) - CLI context engine design

### Architecture

- [docs/adr/](../docs/adr/) - Architecture Decision Records (16 ADRs)
- [.agents/summary/architecture.md](../.agents/summary/architecture.md) - System architecture
- [.agents/summary/components.md](../.agents/summary/components.md) - Package/app breakdown
- [.agents/summary/data_models.md](../.agents/summary/data_models.md) - Schema documentation

### Capabilities

- [docs/capabilities/](../docs/capabilities/) - 140+ capability docs
- [packages/oxagen/src/contracts/](../packages/oxagen/src/contracts/) - 383 contract definitions

---

## Common Gotchas & Solutions

### 1. TenantScopeError

**Problem:** Missing `runInTenantScope` wrapper
**Solution:** Wrap all DB queries in scoped capabilities:

```typescript
await runInTenantScope({ orgId, workspaceId }, async (db) => {
  // queries here
});
```

### 2. Manifest Check Fails

**Problem:** API and MCP capabilities out of sync
**Solution:** Ensure capability is registered in both or excluded from one via `surfaces` field

### 3. Migration Conflicts

**Problem:** Multiple migrations touch same table
**Solution:** Always pull latest `main` before creating migrations

### 4. Test Coverage Drop

**Problem:** New code without tests
**Solution:** Add tests before committing - thresholds are enforced

### 5. Import Errors

**Problem:** Direct imports from `@oxagen/ui/components/*`
**Solution:** Use re-export layer: `@/components/ui/<name>`

---

## Performance Targets

### Latency Budgets

- **API Response:** p50 < 100ms (excluding LLM)
- **Web App FCP:** < 1.5s
- **Database Query:** p99 < 50ms
- **Graph Traversal:** p99 < 200ms

### Build Times

- **Turbo (cached):** < 10s
- **Turbo (uncached):** < 3min
- **Full gate:** < 5min

### Test Times

- **Unit tests:** < 30s
- **Integration tests:** < 2min
- **E2E suite:** < 5min

---

## Security & Compliance

### Access Control

- **IAM:** Role-based, capability-level
- **RLS:** PostgreSQL Row-Level Security
- **Tenancy:** Enforced at kernel + DB layer
- **Audit:** All capability invocations logged to ClickHouse

### Privacy

- **GDPR:** Right to erasure supported
- **Encryption:** At-rest and in-transit
- **PII:** Marked fields, automated handling
- **Retention:** Configurable per data type

### Secrets Management

- **Local:** `.env.local` (gitignored)
- **CI:** GitHub Secrets
- **Production:** Vercel Environment Variables
- **Rotation:** Via environment variable updates

---

## Troubleshooting

### Development Server Won't Start

```bash
# Kill hanging processes
pnpm kill

# Clear caches
pnpm clean:cache

# Restart Docker
docker compose -f docker-compose.dev.yml restart

# Fresh start
pnpm dev
```

### Database Connection Issues

```bash
# Check Docker status
docker ps

# Verify DATABASE_URL
pnpm env:check

# Reset database
pnpm db:reset
pnpm db:migrate
```

### Build Failures

```bash
# Clear Turbo cache
rm -rf .turbo node_modules/.cache

# Reinstall dependencies
pnpm install --force

# Rebuild
pnpm build
```

### Test Failures

```bash
# Clear test caches
rm -rf coverage/ .vitest/

# Run with verbose output
pnpm test -- --reporter=verbose

# Run specific test
pnpm test -- <test-file>
```

---

## Support & Resources

### Documentation

- **Main Docs:** https://docs.oxagen.sh
- **API Reference:** https://api.oxagen.sh/docs
- **Component Library:** http://localhost:6007 (Storybook)

### Internal Resources

- **ADRs:** [docs/adr/](../docs/adr/)
- **Guides:** [docs/guides/](../docs/guides/)
- **Specs:** [docs/specs/](../docs/specs/)

### Community

- **GitHub:** https://github.com/oxagenai/oxagen-monorepo
- **Linear:** Project tracking
- **Slack:** Team communication

---

## Version History

- **0.5.0** (Current) - Enhanced CLI, context engine
- **0.4.0** - Marketplace, plugins
- **0.3.0** - Agent runtime
- **0.2.0** - Foundations epic
- **0.1.0** - Initial release

---

**Last Updated:** June 2024
**Maintained By:** Oxagen Platform Team
**License:** Proprietary
