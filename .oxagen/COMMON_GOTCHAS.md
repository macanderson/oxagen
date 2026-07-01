# Common Gotchas & Solutions

**Purpose:** Catalog of common mistakes, antipatterns, and their solutions to help agent coders avoid repeated errors.

---

## Database & Schema

### ❌ Missing Tenant Scope Wrapper

**Error:**

```
TenantScopeError: Database query attempted outside tenant scope
```

**Bad:**

```typescript
export async function handler(input: Input): Promise<Output> {
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, input.workspaceId),
  });
  return { workspace };
}
```

**Good:**

```typescript
import { runInTenantScope } from '@oxagen/tenancy';

export async function handler(input: Input): Promise<Output> {
  return await runInTenantScope(
    { orgId: input.orgId, workspaceId: input.workspaceId },
    async (db) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.workspaceId),
      });
      return { workspace };
    },
  );
}
```

---

### ❌ Manual Migration Files

**Bad:**

```bash
# Manually creating migration file
touch packages/database/migrations/001_add_table.sql
```

**Good:**

```bash
# Let Atlas generate migrations
pnpm db:migrate:diff
# Review generated file in packages/database/atlas/migrations/
```

**Why:** Manual migrations bypass Atlas's migration tracking and will fail `pnpm db:lint-migrations`.

---

### ❌ N+1 Queries

**Bad:**

```typescript
const workspaces = await db.query.workspaces.findMany();

for (const workspace of workspaces) {
  const members = await db.query.members.findMany({
    where: eq(members.workspaceId, workspace.id),
  });
  workspace.members = members;
}
```

**Good:**

```typescript
// Option 1: Use Drizzle relations
const workspaces = await db.query.workspaces.findMany({
  with: {
    members: true,
  },
});

// Option 2: Batch query
const workspaceIds = workspaces.map((w) => w.id);
const allMembers = await db.query.members.findMany({
  where: inArray(members.workspaceId, workspaceIds),
});
```

---

### ❌ Wrong DATABASE_URL Target

**Problem:** Running migrations against production instead of local

**Prevention:**

```bash
# Always verify before migrations
echo $DATABASE_URL
# Should show: postgresql://localhost:5433/...

# If wrong, unset and use .env.local
unset DATABASE_URL
pnpm db:migrate
```

---

### ❌ Cross-Schema Foreign Keys in Schema Files

**Bad:**

```typescript
// In packages/database/src/schema/workspace.ts
import { users } from './org';

export const workspaces = workspaceSchema.table('workspaces', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').references(() => users.id), // ❌ Cross-schema FK
});
```

**Good:**

```typescript
// In packages/database/src/schema/workspace.ts
export const workspaces = workspaceSchema.table('workspaces', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id'), // No FK constraint
});

// In packages/database/src/relations.ts
import { relations } from 'drizzle-orm';
import { workspaces } from './schema/workspace';
import { users } from './schema/org';

export const workspaceRelations = relations(workspaces, ({ one }) => ({
  owner: one(users, {
    fields: [workspaces.ownerId],
    references: [users.id],
  }),
}));
```

**Why:** Cross-domain foreign key constraints in Postgres create tight coupling and can cause migration ordering issues.

---

## Capability System

### ❌ Forgetting Barrel Export

**Error:**

```
Contract 'my.new.capability' not found in registry
```

**Problem:** Defined contract but didn't add to barrel

**Solution:**

```typescript
// packages/oxagen/src/contracts/index.ts
export * from './my.new.capability'; // Add this line
```

**Verification:**

```bash
pnpm check:contracts
```

---

### ❌ Handler Not Registered

**Error:**

```
No handler registered for capability 'my.new.capability'
```

**Problem:** Implemented handler but didn't register it

**Solution:**

```typescript
// packages/handlers/src/register.ts
registerHandler('my.new.capability', async () => {
  const { handler } = await import('./my-new-capability');
  return handler;
});
```

---

### ❌ Wrong defaultEffect

**Bad:**

```typescript
defineContract({
  name: 'org.settings.update',
  defaultEffect: 'allow', // ❌ Admin operation should be deny-by-default
  // ...
});
```

**Good:**

```typescript
defineContract({
  name: 'org.settings.update',
  defaultEffect: 'deny', // ✅ Require explicit permission
  defaultRoles: {
    org: {
      Owner: 'allow',
      Admin: 'allow',
    },
  },
  // ...
});
```

**Rule:** Use `'allow'` only for truly public read operations. Most capabilities should be `'deny'`.

---

### ❌ Missing noBillingGate for Management Ops

**Bad:**

```typescript
defineContract({
  name: 'workspace.settings.update',
  noBillingGate: false, // ❌ Settings shouldn't consume credits
  // ...
});
```

**Good:**

```typescript
defineContract({
  name: 'workspace.settings.update',
  noBillingGate: true, // ✅ Management operation, no AI usage
  // ...
});
```

**Rule:** Set `noBillingGate: true` for settings, configuration, and management operations that don't use AI.

---

### ❌ API/MCP Surface Mismatch

**Error:**

```
Manifest check failed: capability 'chat.message.send' exposed on API but not MCP
```

**Problem:** Capability surfaces don't match intent

**Solution:**

```typescript
// If should be on both
defineContract({
  surfaces: ['api', 'mcp'], // ✅
  // ...
});

// If intentionally only API
defineContract({
  surfaces: ['api'], // ✅ MCP will be excluded
  // ...
});
```

**Verification:**

```bash
pnpm check:manifest
```

---

## UI & Components

### ❌ Direct Import from @oxagen/ui/components

**Error:**

```
ESLint: Do not import directly from @oxagen/ui/components/*
```

**Bad:**

```typescript
import { Button } from '@oxagen/ui/components/button'; // ❌
```

**Good:**

```typescript
import { Button } from '@/components/ui/button'; // ✅
```

**Why:** Re-export layer allows app-specific overrides without changing all import sites.

---

### ❌ Using Generic Tokens in Shell Components

**Bad:**

```typescript
<div className="bg-background text-foreground"> {/* ❌ */}
  <nav className="border-b border-border">
    <a className="text-muted-foreground hover:text-foreground">
      Link
    </a>
  </nav>
</div>
```

**Good:**

```typescript
<div className="bg-app-panel-bg text-app-panel-fg"> {/* ✅ */}
  <nav className="border-b border-app-topbar-border">
    <a className="text-app-link-fg hover:text-app-link-hover-fg">
      Link
    </a>
  </nav>
</div>
```

**Rule:** Shell/chrome components must use component-level design tokens for reskinning.

---

### ❌ Client Component Where Server Component Would Work

**Bad:**

```typescript
'use client'; // ❌ Unnecessary

export default function Page() {
  const data = useData(); // Could be async Server Component
  return <div>{data}</div>;
}
```

**Good:**

```typescript
// No 'use client' directive
export default async function Page() {
  const data = await fetchData(); // ✅ Direct DB query
  return <div>{data}</div>;
}
```

**Rule:** Use Server Components by default. Only add `'use client'` when you need:

- Browser APIs (localStorage, window)
- React hooks (useState, useEffect)
- Event handlers (onClick, onChange)
- Third-party client libraries

---

### ❌ Missing Suspense Boundary

**Bad:**

```typescript
export default async function Page() {
  const data = await fetchData(); // ❌ Blocks entire page
  return <div>{data}</div>;
}
```

**Good:**

```typescript
import { Suspense } from 'react';

export default function Page() {
  return (
    <div>
      <Header /> {/* Renders immediately */}
      <Suspense fallback={<Skeleton />}>
        <DataComponent /> {/* Streams in when ready */}
      </Suspense>
    </div>
  );
}

async function DataComponent() {
  const data = await fetchData();
  return <div>{data}</div>;
}
```

---

## Testing

### ❌ Not Clearing Test State

**Bad:**

```typescript
import { describe, it } from 'vitest';
import { invoke } from '@oxagen/oxagen';

describe('my capability', () => {
  it('test 1', async () => {
    await invoke('my.capability', input);
    // Handler state leaks to next test
  });

  it('test 2', async () => {
    // May fail due to leaked state
  });
});
```

**Good:**

```typescript
import { describe, it, beforeEach } from 'vitest';
import { clearHandlersForTests } from '@oxagen/oxagen';
import { clearBillingAdmissionGate } from '@oxagen/billing';

describe('my capability', () => {
  beforeEach(() => {
    clearHandlersForTests();
    clearBillingAdmissionGate();
  });

  it('test 1', async () => {
    // Clean state
  });

  it('test 2', async () => {
    // Clean state
  });
});
```

---

### ❌ Committed .skip() or .only()

**Bad:**

```typescript
describe.only('my tests', () => {
  // ❌ Will skip all other tests
  it('works', () => {
    // ...
  });
});

it.skip('broken test', () => {
  // ❌ Hiding broken test
  // ...
});
```

**Good:**

```typescript
describe('my tests', () => {
  it('works', () => {
    // ...
  });
});

// If test needs to be skipped, fix it or file an issue
```

**Rule:** Never commit `.skip()` or `.only()` - they break CI.

---

### ❌ Missing E2E Screenshots for UI Changes

**Bad:**

```typescript
test('updates workspace name', async ({ page }) => {
  await page.fill('[name="name"]', 'New Name');
  await page.click('button[type="submit"]');

  await expect(page.locator('[role="alert"]')).toContainText('Updated');
  // ❌ No screenshot
});
```

**Good:**

```typescript
test('updates workspace name', async ({ page }) => {
  await page.fill('[name="name"]', 'New Name');
  await page.click('button[type="submit"]');

  await expect(page.locator('[role="alert"]')).toContainText('Updated');

  // ✅ Screenshot success state
  await page.screenshot({
    path: 'screenshots/workspace-name-updated.png',
  });
});
```

**Rule:** UI changes require E2E tests with screenshots of success states.

---

### ❌ Lowering Coverage Thresholds

**Bad:**

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      thresholds: {
        statements: 70, // ❌ Lowered from 75
      },
    },
  },
});
```

**Good:**

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    coverage: {
      thresholds: {
        statements: 75, // ✅ Maintained or increased
      },
    },
  },
});
```

**Rule:** Coverage thresholds are ratchets - they only go up, never down (cap at 90).

---

## Background Jobs

### ❌ Non-Idempotent Inngest Functions

**Bad:**

```typescript
export const processEvent = inngest.createFunction(
  { id: 'process-event' },
  { event: 'my/event' },
  async ({ event }) => {
    // ❌ No idempotency check
    await db.insert(records).values({ data: event.data });
    return { success: true };
  },
);
```

**Good:**

```typescript
import { computeEventHash } from '../lib/hash';

export const processEvent = inngest.createFunction(
  { id: 'process-event' },
  { event: 'my/event' },
  async ({ event, step }) => {
    // ✅ Check if already processed
    const eventHash = computeEventHash(event);

    const exists = await step.run('check-duplicate', async () => {
      return await checkIfProcessed(eventHash);
    });

    if (exists) {
      return { skipped: true, reason: 'already processed' };
    }

    await step.run('process', async () => {
      await db.insert(records).values({ data: event.data });
    });

    await step.run('mark-complete', async () => {
      await markProcessed(eventHash);
    });

    return { success: true };
  },
);
```

**Rule:** All Inngest functions must be idempotent - use `computeEventHash` for deduplication.

---

### ❌ Throwing Non-Retriable Errors

**Bad:**

```typescript
export const myFunction = inngest.createFunction(
  { id: 'my-function' },
  { event: 'my/event' },
  async ({ event }) => {
    const data = await fetchData();
    if (!data.isValid) {
      throw new Error('Invalid data'); // ❌ Will retry indefinitely
    }
  },
);
```

**Good:**

```typescript
import { NonRetriableError } from 'inngest';

export const myFunction = inngest.createFunction(
  { id: 'my-function' },
  { event: 'my/event' },
  async ({ event }) => {
    const data = await fetchData();
    if (!data.isValid) {
      // ✅ Don't retry validation errors
      throw new NonRetriableError('Invalid data');
    }
  },
);
```

**Rule:** Use `NonRetriableError` for validation/business logic errors that won't succeed on retry.

---

## Environment & Configuration

### ❌ Undeclared Environment Variables

**Error:**

```
Environment variable MY_VAR is required but not found
```

**Problem:** Used env var without declaring it in registry

**Solution:**

```typescript
// packages/config/src/registry.ts
export const MY_VAR = defineEnvVar({
  key: 'MY_VAR',
  schema: z.string().min(1),
  description: 'What it does',
  required: true,
});
```

**Also update:**

```bash
# .env.example
MY_VAR=example-value
```

**Verification:**

```bash
pnpm env:check
```

---

### ❌ Hardcoded Configuration

**Bad:**

```typescript
const API_URL = 'https://api.production.com'; // ❌ Hardcoded
```

**Good:**

```typescript
import { envConfig } from '@oxagen/config';

const API_URL = envConfig.NEXT_PUBLIC_API_URL; // ✅ From env
```

**Rule:** No hardcoded URLs, API keys, or configuration - use environment variables.

---

## Git & Version Control

### ❌ Pushing Without Running Gate

**Bad:**

```bash
git commit -m "feat: add feature"
git push # ❌ Skipped gate
```

**Good:**

```bash
pnpm gate # ✅ Run gate first

# Only if gate passes:
git commit -m "feat: add feature"
# Leave unpushed for Mac to push
```

**Rule:** `pnpm gate` must pass before committing. Never use `--no-verify`.

---

### ❌ Committing .env.local

**Bad:**

```bash
git add .env.local # ❌ Contains secrets
git commit
```

**Good:**

```bash
# .env.local is gitignored by default
# If accidentally staged:
git reset .env.local
```

**Prevention:** `.env.local` is in `.gitignore` - don't force-add it.

---

### ❌ Large Files in Git

**Bad:**

```bash
git add large-dataset.json # ❌ 50MB file
```

**Good:**

```bash
# Store large files externally
# Use Vercel Blob for assets:
import { put } from '@vercel/blob';
await put('large-dataset.json', file, { access: 'public' });
```

**Rule:** Keep repo under 1GB. Use blob storage for large assets.

---

## Performance

### ❌ Fetching Data in Client Components

**Bad:**

```typescript
'use client';

export default function Page() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch('/api/data')
      .then(r => r.json())
      .then(setData);
  }, []); // ❌ Client-side fetch, waterfall

  return <div>{data?.value}</div>;
}
```

**Good:**

```typescript
// Server Component (no 'use client')
export default async function Page() {
  const data = await fetchData(); // ✅ Server-side, faster
  return <div>{data.value}</div>;
}
```

---

### ❌ Not Using Indexes

**Bad:**

```typescript
// Frequent query with no index
const workspaces = await db.query.workspaces.findMany({
  where: eq(workspaces.orgId, orgId), // ❌ Full table scan
});
```

**Good:**

```typescript
// packages/database/src/schema/workspace.ts
export const workspaceOrgIndex = pgIndex('workspace_org_idx').on(
  workspaces.orgId,
); // ✅ Index on orgId

// Query is now fast
const workspaces = await db.query.workspaces.findMany({
  where: eq(workspaces.orgId, orgId),
});
```

**Rule:** Add indexes for foreign keys and common query patterns.

---

### ❌ Overfetching Data

**Bad:**

```typescript
// Fetch entire workspace object
const workspace = await db.query.workspaces.findFirst({
  where: eq(workspaces.id, id),
  with: {
    members: true,
    agents: true,
    chats: true,
    // ... everything
  },
}); // ❌ Returns MB of data

return { name: workspace.name }; // Only need name
```

**Good:**

```typescript
// Fetch only needed fields
const workspace = await db
  .select({ name: workspaces.name })
  .from(workspaces)
  .where(eq(workspaces.id, id))
  .limit(1);

return { name: workspace[0].name };
```

---

## Security

### ❌ SQL Injection via String Interpolation

**Bad:**

```typescript
// ❌ SQL injection vulnerability
const query = `SELECT * FROM workspaces WHERE id = '${input.id}'`;
await db.execute(query);
```

**Good:**

```typescript
// ✅ Parameterized query (Drizzle handles this)
const workspace = await db.query.workspaces.findFirst({
  where: eq(workspaces.id, input.id),
});
```

**Rule:** Never use string interpolation for SQL. Always use Drizzle query builder.

---

### ❌ Exposing Sensitive Data in Logs

**Bad:**

```typescript
console.log('User input:', input); // ❌ May contain passwords, tokens
```

**Good:**

```typescript
import pino from 'pino';
const logger = pino();

logger.info(
  { userId: input.userId, action: input.action }, // ✅ Sanitized
  'Processing user action',
);
```

**Rule:** Never log raw user input, passwords, or tokens.

---

### ❌ Missing Input Validation

**Bad:**

```typescript
export async function handler(input: Input): Promise<Output> {
  // ❌ Trusts input without validation
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, input.workspaceId),
  });
  // ...
}
```

**Good:**

```typescript
// Validation happens in contract
defineContract({
  name: 'workspace.get',
  input: z.object({
    workspaceId: z.string().uuid(), // ✅ Validates format
  }),
  // ...
});

// Kernel validates input before calling handler
```

**Rule:** Define strict Zod schemas in contracts - kernel validates before handlers run.

---

## TypeScript

### ❌ Using `any`

**Bad:**

```typescript
function processData(data: any) {
  // ❌
  return data.value;
}
```

**Good:**

```typescript
function processData(data: { value: string }) {
  // ✅
  return data.value;
}

// Or with Zod
const DataSchema = z.object({ value: z.string() });
type Data = z.infer<typeof DataSchema>;

function processData(data: Data) {
  return data.value;
}
```

**Rule:** Never use `any` without a comment explaining why it's necessary.

---

### ❌ Missing Return Types

**Bad:**

```typescript
async function fetchWorkspace(id: string) {
  // ❌ Inferred return type
  return await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
  });
}
```

**Good:**

```typescript
async function fetchWorkspace(id: string): Promise<Workspace | null> {
  // ✅
  return await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
  });
}
```

**Rule:** Explicit return types on all public functions.

---

### ❌ Non-Null Assertions Without Comments

**Bad:**

```typescript
const workspace = workspaces.find((w) => w.id === id)!; // ❌ Dangerous
```

**Good:**

```typescript
const workspace = workspaces.find((w) => w.id === id);
if (!workspace) {
  throw new Error('Workspace not found');
}
// Now TypeScript knows workspace is defined
```

**Rule:** Avoid non-null assertions (`!`). If necessary, add a comment explaining why it's safe.

---

## Debugging Tips

### ❌ Not Using Debugger

**Bad:**

```typescript
console.log('1'); // ❌ Console spam
console.log('2');
console.log(data);
console.log('3');
```

**Good:**

```typescript
// Set breakpoint in VS Code
debugger; // ✅ Or use this
// Inspect variables in debugger
```

---

### ❌ Not Checking Logs

**Problem:** Error happens but no investigation

**Solution:**

```bash
# Check application logs
docker logs <container-name>

# Check Postgres logs
docker logs oxagen-postgres-1

# Check Inngest UI
# Visit: http://localhost:8288
```

---

### ❌ Not Reproducing Locally

**Problem:** "It works on my machine" (but fails in CI)

**Solution:**

```bash
# Reset local environment
pnpm kill -- --volumes
pnpm install
pnpm dev

# Run full gate (same as CI)
pnpm gate
```

---

## Quick Checklist for New Features

Before committing:

- [ ] Capability contract defined
- [ ] Barrel export added
- [ ] Handler implemented with tenant scoping
- [ ] Handler registered (lazy loaded)
- [ ] Tests written (happy + error paths)
- [ ] E2E test with screenshot (if UI)
- [ ] MCP tool added (if needed)
- [ ] CLI command added (if needed)
- [ ] `pnpm check:contracts` passes
- [ ] `pnpm check:manifest` passes
- [ ] `pnpm gate` passes
- [ ] Branch committed, NOT pushed

---

## Quick Checklist for Database Changes

- [ ] Schema changes in appropriate schema file
- [ ] `pnpm db:migrate:diff` run (not manual file)
- [ ] Migration reviewed
- [ ] `pnpm db:lint-migrations` passes
- [ ] `pnpm db:atlas-validate` passes
- [ ] Migration applied locally
- [ ] Verified with manual query
- [ ] Relations added (if needed)
- [ ] Committed with descriptive message

---

## When in Doubt

1. **Read the error message carefully** - it usually tells you what's wrong
2. **Check the logs** - application, database, job queue
3. **Verify your environment** - `pnpm env:check`
4. **Run the gate** - `pnpm gate` catches most issues
5. **Search existing code** - `grep -r "similar pattern" packages/`
6. **Ask for help** - better to ask than break production

---

**Last Updated:** June 2024
