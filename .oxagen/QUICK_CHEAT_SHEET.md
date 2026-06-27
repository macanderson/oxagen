# Quick Cheat Sheet

**1-page reference for the most common tasks and commands**

---

## Essential Commands

```bash
# Development
pnpm dev                          # Start everything
pnpm kill                         # Stop everything
pnpm gate                         # Full verification (MUST pass before commit)

# Testing
pnpm test                         # Unit tests
pnpm test:e2e                     # E2E tests
pnpm test -- <file>               # Specific test

# Database
pnpm db:migrate:diff              # Create migration
pnpm db:migrate                   # Apply migrations
pnpm db:reset                     # Reset database

# Verification
pnpm check:manifest               # API ↔ MCP parity
pnpm check:contracts              # Contract barrel
pnpm typecheck                    # TypeScript
pnpm lint                         # ESLint

# CLI Development
pnpm cli:dev                      # Install CLI to PATH + watch
oxagen --help                     # Use CLI
```

---

## File Locations

```
Capabilities:     packages/oxagen/src/contracts/<name>.ts
Handlers:         packages/handlers/src/<name>.ts
Tests:            <file>.test.ts (next to source)
E2E Tests:        apps/app/e2e/<feature>.spec.ts
Schemas:          packages/database/src/schema/<domain>.ts
Migrations:       packages/database/atlas/migrations/ (auto-generated)
UI Components:    packages/ui/src/components/<name>.tsx
Re-exports:       apps/app/src/components/ui/<name>.tsx
```

---

## Adding a Capability (5 Steps)

```typescript
// 1. Contract: packages/oxagen/src/contracts/my.new.cap.ts
export const myNewCap = defineContract({
  name: 'my.new.cap',
  input: z.object({ /* ... */ }),
  output: z.object({ /* ... */ }),
  surfaces: ['api', 'mcp'],
  defaultEffect: 'deny',
  noBillingGate: true, // if settings/mgmt op
});

// 2. Barrel: packages/oxagen/src/contracts/index.ts
export * from './my.new.cap';

// 3. Handler: packages/handlers/src/my-new-cap.ts
export async function handler(input: Input): Promise<Output> {
  return await runInTenantScope(
    { orgId: input.orgId, workspaceId: input.workspaceId },
    async (db) => { /* implementation */ }
  );
}

// 4. Register: packages/handlers/src/register.ts
registerHandler('my.new.cap', async () => {
  const { handler } = await import('./my-new-cap');
  return handler;
});

// 5. Test: packages/handlers/src/my-new-cap.test.ts
// Write tests

// Verify
pnpm check:contracts
pnpm check:manifest
pnpm gate
```

---

## Creating a Migration (3 Steps)

```bash
# 1. Edit schema: packages/database/src/schema/<domain>.ts
export const myTable = mySchema.table('my_table', { /* ... */ });

# 2. Generate migration
pnpm db:migrate:diff

# 3. Apply locally
pnpm db:migrate

# Verify
pnpm db:lint-migrations
pnpm db:atlas-validate
```

---

## Critical Patterns

### Tenant Scoping (ALWAYS)
```typescript
import { runInTenantScope } from '@oxagen/tenancy';

await runInTenantScope({ orgId, workspaceId }, async (db) => {
  // ALL DB queries here
});
```

### Component Imports (RE-EXPORT LAYER)
```typescript
// ✅ Correct
import { Button } from '@/components/ui/button';

// ❌ Forbidden
import { Button } from '@oxagen/ui/components/button';
```

### Test Setup
```typescript
import { beforeEach } from 'vitest';
import { clearHandlersForTests } from '@oxagen/oxagen';
import { clearBillingAdmissionGate } from '@oxagen/billing';

beforeEach(() => {
  clearHandlersForTests();
  clearBillingAdmissionGate();
});
```

---

## Storage Decision

| Data Type | Use |
|-----------|-----|
| User/Org/Workspace state | PostgreSQL |
| IAM/Billing/Config | PostgreSQL |
| Entities/Relationships | Neo4j |
| Agent memory/context | Neo4j |
| Audit events/Token usage | ClickHouse |

---

## Git Workflow

```bash
# 1. Start fresh
git fetch origin
git switch main
git rebase origin/main

# 2. Cut branch
git checkout -b feature/my-feature

# 3. Make changes, test frequently
pnpm test

# 4. Before final commit
pnpm gate  # MUST pass

# 5. Commit and STOP (don't push)
git commit -m "feat: add feature"
# Leave unpushed for Mac
```

---

## Quick Debugging

```bash
# Check services
docker ps

# Check logs
docker logs oxagen-postgres-1
docker logs oxagen-neo4j-1

# Verify environment
pnpm env:check

# Check DATABASE_URL
echo $DATABASE_URL  # Should be localhost:5433

# Reset everything
pnpm kill -- --volumes
pnpm dev
```

---

## Common Errors

| Error | Fix |
|-------|-----|
| TenantScopeError | Add `runInTenantScope` wrapper |
| Contract not found | Add to barrel export |
| Handler not registered | Register in `register.ts` |
| Manifest check failed | Sync surfaces or adjust |
| Coverage dropped | Add tests |
| Direct import lint error | Use re-export layer |

---

## IAM Defaults

```typescript
defaultEffect: 'deny'      // Most capabilities
defaultEffect: 'allow'     // Only for public reads

sensitivity: 'high'        // PII, financial, admin
sensitivity: 'medium'      // User data, business logic
sensitivity: 'low'         // Public info, read-only

noBillingGate: true        // Settings/mgmt (no AI)
noBillingGate: false       // AI-powered features
```

---

## Performance Quick Wins

```typescript
// ❌ N+1 query
for (const workspace of workspaces) {
  const members = await db.query.members.findMany({
    where: eq(members.workspaceId, workspace.id),
  });
}

// ✅ Single query
const workspaces = await db.query.workspaces.findMany({
  with: { members: true },
});

// ❌ Overfetch
const workspace = await db.query.workspaces.findFirst({
  where: eq(workspaces.id, id),
  with: { /* everything */ },
});

// ✅ Select only needed
const workspace = await db
  .select({ name: workspaces.name })
  .from(workspaces)
  .where(eq(workspaces.id, id));
```

---

## Environment Variables

```typescript
// 1. Declare in packages/config/src/registry.ts
export const MY_VAR = defineEnvVar({
  key: 'MY_VAR',
  schema: z.string().min(1),
  description: 'What it does',
  required: true,
});

// 2. Add to .env.example
MY_VAR=example-value

// 3. Verify
pnpm env:check
```

---

## Test Requirements

- ✅ Happy path
- ✅ Error cases
- ✅ Edge cases
- ✅ Screenshots for UI changes (E2E)
- ✅ Coverage maintained or increased
- ❌ No `.skip()` or `.only()` in commits

---

## Pre-Commit Checklist

- [ ] `pnpm gate` passes
- [ ] Tests written
- [ ] No console.logs left
- [ ] No `.only()` or `.skip()`
- [ ] Secrets not committed
- [ ] Committed on branch (not main)
- [ ] NOT pushed (leave for Mac)

---

## Quick Links

- **Full Docs:** [INDEX.md](INDEX.md)
- **Overview:** [MONOREPO_OVERVIEW.md](MONOREPO_OVERVIEW.md)
- **Architecture:** [ARCHITECTURE_QUICK_REF.md](ARCHITECTURE_QUICK_REF.md)
- **Procedures:** [PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md](PROCEDURAL_MEMORY_FEATURE_DEVELOPMENT.md)
- **Gotchas:** [COMMON_GOTCHAS.md](COMMON_GOTCHAS.md)

---

**Last Updated:** June 2024
