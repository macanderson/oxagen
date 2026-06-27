# Procedural Memory: Feature Development on Oxagen

**Purpose:** Step-by-step procedures for common development tasks to maximize efficiency and maintain quality.

---

## Table of Contents

1. [Adding a New Capability](#1-adding-a-new-capability)
2. [Creating Database Migrations](#2-creating-database-migrations)
3. [Building UI Components](#3-building-ui-components)
4. [Implementing Background Jobs](#4-implementing-background-jobs)
5. [Adding Connectors](#5-adding-connectors)
6. [Writing Tests](#6-writing-tests)
7. [Debugging Issues](#7-debugging-issues)
8. [Performance Optimization](#8-performance-optimization)

---

## 1. Adding a New Capability

### Context
Capabilities are the core abstraction in Oxagen. Every feature is a capability with a contract, handler, and optional surface-specific implementations.

### Prerequisites
- [ ] Understand the feature requirements
- [ ] Determine IAM requirements (who can use it)
- [ ] Identify which surfaces need it (API, MCP, agent, CLI)
- [ ] Know if it requires billing credits

### Procedure

#### Step 1: Define the Contract

**Location:** `packages/oxagen/src/contracts/<domain>.<feature>.<action>.ts`

```typescript
import { defineContract } from '../define-contract';
import { z } from 'zod';

export const myNewCapability = defineContract({
  // Unique dot-notation name (follows pattern: domain.feature.action)
  name: 'workspace.settings.update',
  
  // Input schema (what the caller provides)
  input: z.object({
    workspaceId: z.string(),
    name: z.string().min(1).max(100),
    settings: z.object({
      // nested settings
    }).optional(),
  }),
  
  // Output schema (what the handler returns)
  output: z.object({
    success: z.boolean(),
    workspace: z.object({
      id: z.string(),
      name: z.string(),
      // ... other fields
    }),
  }),
  
  // Where this capability is exposed
  surfaces: ['api', 'mcp'], // or ['api', 'mcp', 'agent', 'cli']
  
  // IAM default: "deny" = requires explicit permission, "allow" = public
  defaultEffect: 'deny',
  
  // Importance level for audit logging
  sensitivity: 'medium', // 'low' | 'medium' | 'high'
  
  // If true, skip billing credit check (for settings/management ops)
  noBillingGate: true,
  
  // Default role permissions (seeded via seed-iam-defaults.ts)
  defaultRoles: {
    org: {
      Owner: 'allow',
      Admin: 'allow',
    },
    workspace: {
      Admin: 'allow',
      Member: 'deny',
    },
  },
  
  // Optional: description for docs
  description: 'Updates workspace settings and configuration',
  
  // Optional: tags for categorization
  tags: ['workspace', 'settings'],
});
```

**Key Decisions:**

- **defaultEffect:**
  - Use `"deny"` for most capabilities (require explicit permission)
  - Use `"allow"` only for truly public reads (e.g., public docs)

- **sensitivity:**
  - `"high"` = PII, financial data, admin actions
  - `"medium"` = user data, business logic
  - `"low"` = public info, read-only

- **noBillingGate:**
  - Set `true` for settings/config that don't consume AI
  - Set `false` (default) for AI-powered features

- **surfaces:**
  - `"api"` = REST endpoints (always include for web app)
  - `"mcp"` = MCP tools (for IDE/agent integration)
  - `"agent"` = Available to AI agents
  - `"cli"` = CLI commands

#### Step 2: Add to Barrel Export

**Location:** `packages/oxagen/src/contracts/index.ts`

```typescript
// Add alphabetically within the appropriate section
export * from './workspace.settings.update';
```

#### Step 3: Implement the Handler

**Location:** `packages/handlers/src/<domain>-<feature>-<action>.ts`

```typescript
import type { InferInput, InferOutput } from '@oxagen/oxagen';
import { myNewCapability } from '@oxagen/oxagen/contracts/my.new.capability';
import { runInTenantScope } from '@oxagen/tenancy';
import { eq } from 'drizzle-orm';
import { workspaces } from '@oxagen/database/schema';

type Input = InferInput<typeof myNewCapability>;
type Output = InferOutput<typeof myNewCapability>;

export async function handler(input: Input): Promise<Output> {
  const { workspaceId, name, settings } = input;
  
  // CRITICAL: All DB queries must be inside runInTenantScope
  const result = await runInTenantScope(
    { orgId: input.orgId, workspaceId },
    async (db) => {
      // Update workspace
      const [workspace] = await db
        .update(workspaces)
        .set({
          name,
          settings: settings ?? {},
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspaceId))
        .returning();
      
      if (!workspace) {
        throw new Error('Workspace not found');
      }
      
      return workspace;
    }
  );
  
  return {
    success: true,
    workspace: {
      id: result.id,
      name: result.name,
      // map other fields
    },
  };
}
```

**Critical Patterns:**

1. **Tenant Scoping:** ALWAYS use `runInTenantScope` for DB queries in scoped capabilities
2. **Type Safety:** Use `InferInput` and `InferOutput` from contract
3. **Error Handling:** Throw descriptive errors (they're caught by kernel)
4. **Validation:** Input is pre-validated by kernel; focus on business logic

#### Step 4: Register the Handler

**Location:** `packages/handlers/src/register.ts`

```typescript
// Add in alphabetical order
registerHandler('my.new.capability', async () => {
  const { handler } = await import('./my-new-capability');
  return handler;
});
```

**Why lazy loading?** Keeps kernel startup fast; handlers are imported only when invoked.

#### Step 5: Write Tests

**Location:** `packages/handlers/src/<domain>-<feature>-<action>.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { invoke } from '@oxagen/oxagen';
import { clearHandlersForTests } from '@oxagen/oxagen';
import { clearBillingAdmissionGate } from '@oxagen/billing';
import { handler } from './my-new-capability';

describe('my.new.capability', () => {
  beforeEach(() => {
    clearHandlersForTests();
    clearBillingAdmissionGate();
  });
  
  it('should update workspace successfully', async () => {
    // Arrange
    const input = {
      orgId: 'test-org',
      workspaceId: 'test-workspace',
      name: 'New Name',
    };
    
    // Act
    const result = await handler(input);
    
    // Assert
    expect(result.success).toBe(true);
    expect(result.workspace.name).toBe('New Name');
  });
  
  it('should throw error for non-existent workspace', async () => {
    // Arrange
    const input = {
      orgId: 'test-org',
      workspaceId: 'invalid',
      name: 'Name',
    };
    
    // Act & Assert
    await expect(handler(input)).rejects.toThrow('Workspace not found');
  });
});
```

**Test Requirements:**
- ✅ Happy path
- ✅ Error cases
- ✅ Validation edge cases
- ✅ Coverage threshold maintained

#### Step 6: Optional Surface Implementations

**For MCP exposure:**

**Location:** `apps/mcp/src/tools/<domain>-<feature>-<action>.ts`

```typescript
import { z } from 'xmcp';
import { invoke } from '@oxagen/oxagen';

export default {
  name: 'workspace_settings_update',
  description: 'Updates workspace settings',
  input: z.object({
    workspaceId: z.string(),
    name: z.string(),
  }),
  async handler(input) {
    return await invoke('my.new.capability', input);
  },
};
```

**For CLI exposure:**

**Location:** `apps/cli/src/commands/<domain>/<feature>/<action>.ts`

```typescript
import { Command } from 'commander';
import { invoke } from '@oxagen/oxagen';

export const updateWorkspaceCommand = new Command('update')
  .description('Update workspace settings')
  .argument('<workspace-id>', 'Workspace ID')
  .option('-n, --name <name>', 'New workspace name')
  .action(async (workspaceId, options) => {
    const result = await invoke('my.new.capability', {
      workspaceId,
      name: options.name,
    });
    
    console.log('Workspace updated:', result.workspace.name);
  });
```

#### Step 7: Verify

```bash
# Check contract is in barrel
pnpm check:contracts

# Check API/MCP parity (if exposed on both)
pnpm check:manifest

# Run tests
pnpm test

# Run full gate
pnpm gate
```

### Checklist
- [ ] Contract defined with proper defaultEffect and sensitivity
- [ ] Barrel export added
- [ ] Handler implemented with tenant scoping
- [ ] Handler registered (lazy loaded)
- [ ] Tests written (happy + error paths)
- [ ] MCP tool added (if needed)
- [ ] CLI command added (if needed)
- [ ] `pnpm check:contracts` passes
- [ ] `pnpm check:manifest` passes (if on both API + MCP)
- [ ] `pnpm gate` passes

---

## 2. Creating Database Migrations

### Context
All database schema changes go through Atlas migrations. Never hand-write migration files.

### Prerequisites
- [ ] Schema changes defined in `packages/database/src/schema/`
- [ ] `DATABASE_URL` points to local database
- [ ] No uncommitted schema changes

### Procedure

#### Step 1: Make Schema Changes

**Location:** `packages/database/src/schema/<domain>.ts`

```typescript
import { pgSchema } from 'drizzle-orm/pg-core';
import { workspaceSchema } from './_schemas';

export const myNewTable = workspaceSchema.table('my_new_table', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Add indexes
export const myNewTableIndexes = pgSchema.index('my_new_table_workspace_idx')
  .on(myNewTable.workspaceId);
```

**Schema Conventions:**
- Use appropriate schema from `_schemas.ts` (e.g., `workspaceSchema`, `orgSchema`)
- Always include `createdAt` and `updatedAt` timestamps
- Use `text` for IDs (UUIDs), not `serial`
- Add indexes for foreign keys and common query patterns

#### Step 2: Generate Migration

```bash
# Ensure DATABASE_URL is local
echo $DATABASE_URL  # Should show localhost:5433

# Generate migration (Atlas analyzes schema diff)
pnpm db:migrate:diff

# This creates: packages/database/atlas/migrations/<timestamp>_<description>.sql
```

**What Atlas does:**
1. Compares current schema to database state
2. Generates SQL migration file
3. Updates `atlas.sum` with migration hash

#### Step 3: Review Migration

**Location:** `packages/database/atlas/migrations/<timestamp>_*.sql`

```sql
-- Verify the generated SQL makes sense
CREATE TABLE "workspace"."my_new_table" (
  "id" text PRIMARY KEY,
  "workspace_id" text NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "my_new_table_workspace_idx" 
  ON "workspace"."my_new_table" ("workspace_id");
```

**Review checklist:**
- [ ] Correct schema name
- [ ] All columns present
- [ ] Indexes created
- [ ] No unexpected drops
- [ ] Foreign key constraints correct

#### Step 4: Lint Migration

```bash
# Verify migration file integrity
pnpm db:lint-migrations

# Validate Atlas schema
pnpm db:atlas-validate
```

**What's checked:**
- Migration file hash matches `atlas.sum`
- No manual edits detected
- Migration chain is valid

#### Step 5: Apply Migration Locally

```bash
# Apply to local database
pnpm db:migrate

# Verify with a query
psql $DATABASE_URL -c "\dt workspace.my_new_table"
```

**Verification:**
- Table exists in correct schema
- Columns match definition
- Indexes created
- Can insert test data

#### Step 6: Update Relations (if needed)

**Location:** `packages/database/src/relations.ts`

```typescript
import { relations } from 'drizzle-orm';
import { myNewTable, workspaces } from './schema';

export const myNewTableRelations = relations(myNewTable, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [myNewTable.workspaceId],
    references: [workspaces.id],
  }),
}));
```

**When to add relations:**
- Cross-domain foreign keys
- Needed for query joins
- Used in handlers

#### Step 7: Commit

```bash
git add packages/database/
git commit -m "feat(database): add my_new_table schema"
```

### Rollback Procedure

If migration fails in production:

```bash
# Local rollback
pnpm db:migrate:down  # (if implemented)

# Or manual rollback
psql $DATABASE_URL < packages/database/atlas/migrations/<previous>.sql
```

### Checklist
- [ ] Schema changes in `packages/database/src/schema/`
- [ ] Migration generated with `pnpm db:migrate:diff`
- [ ] Migration reviewed and looks correct
- [ ] `pnpm db:lint-migrations` passes
- [ ] `pnpm db:atlas-validate` passes
- [ ] Migration applied locally with `pnpm db:migrate`
- [ ] Verified with manual query
- [ ] Relations added (if needed)
- [ ] Committed with descriptive message

---

## 3. Building UI Components

### Context
UI components follow a strict re-export pattern and use design tokens for theming.

### Prerequisites
- [ ] Design requirements clear
- [ ] Understand re-export pattern
- [ ] Know where component belongs (shared vs app-specific)

### Procedure

#### Step 1: Determine Component Location

**Decision tree:**
- **Shared across apps?** → `packages/ui/src/components/<name>.tsx`
- **App-specific?** → `apps/app/src/components/<name>.tsx`
- **Shell/chrome?** → `apps/app/src/components/ui/shell-*.tsx`

#### Step 2: Create Shared Component (if shared)

**Location:** `packages/ui/src/components/<name>.tsx`

```typescript
import * as React from 'react';
import { cn } from '../lib/utils';
import type { VariantProps } from 'class-variance-authority';
import { cva } from 'class-variance-authority';

const buttonVariants = cva(
  // Base styles
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    );
  }
);

Button.displayName = 'Button';
```

**Component Patterns:**
- Use `cva` for variant management
- Export props interface
- Use `React.forwardRef` for ref forwarding
- Set `displayName` for dev tools
- Use `cn()` utility for className merging

#### Step 3: Create Re-Export Layer

**Location:** `apps/app/src/components/ui/<name>.tsx`

```typescript
// Simple re-export (default case)
export * from '@oxagen/ui/components/button';
```

**Or with app-specific wrapper:**

```typescript
import * as React from 'react';
import { Button as BaseButton, type ButtonProps } from '@oxagen/ui/components/button';
import Link from 'next/link';

// App-specific wrapper that uses Next.js Link
export function Button({ href, ...props }: ButtonProps & { href?: string }) {
  if (href) {
    return (
      <Link href={href}>
        <BaseButton {...props} />
      </Link>
    );
  }
  return <BaseButton {...props} />;
}
```

#### Step 4: Use Design Tokens (for shell components)

**Correct token usage:**

```typescript
// ✅ Component-level tokens (reskinnable)
<div className="bg-app-panel-bg text-app-panel-fg">
  <nav className="bg-app-topbar-bg border-b border-app-topbar-border">
    <a className="text-app-link-fg hover:text-app-link-hover-fg">
      Link
    </a>
  </nav>
</div>
```

**Wrong token usage:**

```typescript
// ❌ Generic tokens (not reskinnable)
<div className="bg-background text-foreground">
  <nav className="bg-background border-b border-border">
    <a className="text-muted-foreground hover:text-foreground">
      Link
    </a>
  </nav>
</div>
```

**Token reference:**

| Area | Token |
|------|-------|
| Content panel | `bg-app-panel-bg`, `text-app-panel-fg` |
| Topbar/header | `bg-app-topbar-bg`, `text-app-topbar-fg`, `border-app-topbar-border` |
| Chrome links | `text-app-link-fg`, `hover:text-app-link-hover-fg`, `text-app-link-active-fg` |
| Sidebar | `bg-sidebar-bg`, `text-sidebar-fg` |
| Sidebar nav | `text-sidebar-nav-link-fg`, `hover:bg-sidebar-nav-link-hover-bg` |

#### Step 5: Write Tests

**Location:** `packages/ui/src/components/<name>.test.tsx` (for shared)  
**Or:** `apps/app/src/components/ui/<name>.test.tsx` (for app-specific)

```typescript
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Button } from './button';

describe('Button', () => {
  it('renders with text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });
  
  it('applies variant classes', () => {
    render(<Button variant="destructive">Delete</Button>);
    const button = screen.getByText('Delete');
    expect(button).toHaveClass('bg-destructive');
  });
  
  it('handles click events', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    screen.getByText('Click').click();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
```

#### Step 6: Document in Storybook (optional)

**Location:** `packages/ui/src/components/<name>.stories.tsx`

```typescript
import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './button';

const meta: Meta<typeof Button> = {
  component: Button,
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Default: Story = {
  args: {
    children: 'Button',
  },
};

export const Destructive: Story = {
  args: {
    variant: 'destructive',
    children: 'Delete',
  },
};
```

#### Step 7: Import Correctly in App

```typescript
// ✅ Correct - uses re-export layer
import { Button } from '@/components/ui/button';

// ❌ Forbidden - bypasses indirection
import { Button } from '@oxagen/ui/components/button';
```

### Checklist
- [ ] Component location correct (shared vs app-specific)
- [ ] Re-export layer created in `apps/app/src/components/ui/`
- [ ] Design tokens used (if shell component)
- [ ] Tests written
- [ ] Storybook story added (optional)
- [ ] Imported via re-export layer, never directly
- [ ] `pnpm lint` passes (checks import restrictions)

---

## 4. Implementing Background Jobs

### Context
Background jobs use Inngest for durable, retryable workflows. Jobs must be idempotent.

### Prerequisites
- [ ] Understand job trigger (event name)
- [ ] Know job idempotency requirements
- [ ] Identify what makes the job unique (for deduplication)

### Procedure

#### Step 1: Define the Function

**Location:** `packages/inngest-functions/src/functions/<domain>-<action>.ts`

```typescript
import { inngest } from '../client';
import { z } from 'zod';
import { computeEventHash } from '../lib/hash';

const eventSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
  action: z.string(),
});

export const processWorkspaceAction = inngest.createFunction(
  {
    id: 'process-workspace-action',
    // Concurrency control
    concurrency: {
      limit: 10,
    },
    // Retries
    retries: 3,
    // Rate limiting (optional)
    rateLimit: {
      limit: 100,
      period: '1m',
    },
  },
  {
    event: 'workspace/action.triggered',
  },
  async ({ event, step }) => {
    // Validate event data
    const data = eventSchema.parse(event.data);
    
    // Step 1: Idempotency check
    const eventHash = computeEventHash(event);
    const exists = await step.run('check-duplicate', async () => {
      return await checkIfProcessed(eventHash);
    });
    
    if (exists) {
      return { skipped: true, reason: 'already processed' };
    }
    
    // Step 2: Main processing
    const result = await step.run('process-action', async () => {
      return await processAction(data);
    });
    
    // Step 3: Update status
    await step.run('mark-complete', async () => {
      return await markProcessed(eventHash, result);
    });
    
    // Step 4: Optional fan-out
    if (result.shouldNotify) {
      await step.sendEvent('send-notification', {
        name: 'notification/send',
        data: {
          userId: data.userId,
          message: result.message,
        },
      });
    }
    
    return { success: true, result };
  }
);
```

**Key Patterns:**

1. **Idempotency:** Use `computeEventHash` to detect duplicates
2. **Steps:** Break work into named steps for observability
3. **Error handling:** Let Inngest retry; throw for retriable errors
4. **Fan-out:** Use `step.sendEvent` for additional jobs
5. **Schemas:** Validate event data with Zod

#### Step 2: Register the Function

**Location:** `packages/inngest-functions/src/functions.ts`

```typescript
import { processWorkspaceAction } from './functions/process-workspace-action';

export const functions = [
  // ... existing functions
  processWorkspaceAction,
];
```

#### Step 3: Trigger from Handler

**Location:** `packages/handlers/src/<capability>.ts`

```typescript
import { inngest } from '@oxagen/inngest-functions';

export async function handler(input: Input): Promise<Output> {
  // Do synchronous work first
  const workspace = await updateWorkspace(input);
  
  // Trigger background job
  await inngest.send({
    name: 'workspace/action.triggered',
    data: {
      workspaceId: workspace.id,
      userId: input.userId,
      action: 'update',
    },
  });
  
  // Return immediately
  return { success: true, workspace };
}
```

#### Step 4: Write Tests

**Location:** `packages/inngest-functions/src/functions/<name>.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { processWorkspaceAction } from './process-workspace-action';

describe('processWorkspaceAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('processes new events', async () => {
    const event = {
      name: 'workspace/action.triggered',
      data: {
        workspaceId: 'test-workspace',
        userId: 'test-user',
        action: 'update',
      },
    };
    
    const result = await processWorkspaceAction(event);
    
    expect(result.success).toBe(true);
  });
  
  it('skips duplicate events', async () => {
    // First call
    await processWorkspaceAction(event);
    
    // Second call with same data
    const result = await processWorkspaceAction(event);
    
    expect(result.skipped).toBe(true);
  });
  
  it('retries on transient errors', async () => {
    // Mock transient error
    vi.mocked(processAction).mockRejectedValueOnce(
      new Error('Database timeout')
    );
    
    // Should retry and succeed
    const result = await processWorkspaceAction(event);
    expect(result.success).toBe(true);
  });
});
```

#### Step 5: Monitor in Development

```bash
# Start Inngest dev server (runs automatically with pnpm dev)
# View UI at: http://localhost:8288

# Manually trigger event for testing
inngest-cli send \
  --event-name workspace/action.triggered \
  --data '{"workspaceId":"test","userId":"user","action":"update"}'
```

### Checklist
- [ ] Function defined with proper ID and config
- [ ] Event schema validated with Zod
- [ ] Idempotency check implemented
- [ ] Work broken into named steps
- [ ] Function registered in `functions.ts`
- [ ] Triggered from handler
- [ ] Tests cover happy path and duplicates
- [ ] Tested in Inngest dev UI

---

## 5. Adding Connectors

### Context
Connectors ingest data from external sources through a universal pipeline.

### Prerequisites
- [ ] API documentation for the source
- [ ] Webhook verification mechanism understood
- [ ] Sample webhook payloads collected
- [ ] Authentication method known

### Procedure

#### Step 1: Create Connector Directory

**Location:** `packages/ingestion/src/connectors/<source-name>/`

```
<source-name>/
├── index.ts           # Main exports
├── types.ts           # Type definitions
├── verify.ts          # Webhook verification
├── normalize.ts       # Payload transformation
└── index.test.ts      # Tests
```

#### Step 2: Define Types

**Location:** `types.ts`

```typescript
import { z } from 'zod';

// Raw webhook payload schema
export const rawWebhookSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({
    object: z.string(),
    attributes: z.record(z.unknown()),
  }),
  created_at: z.string(),
});

export type RawWebhook = z.infer<typeof rawWebhookSchema>;

// Connector-specific config
export interface ConnectorConfig {
  apiKey: string;
  webhookSecret: string;
  environment: 'production' | 'staging';
}
```

#### Step 3: Implement Webhook Verification

**Location:** `verify.ts`

```typescript
import crypto from 'crypto';

export async function verifyWebhook(
  req: Request,
  secret: string
): Promise<boolean> {
  const signature = req.headers.get('x-webhook-signature');
  if (!signature) return false;
  
  const body = await req.text();
  const timestamp = req.headers.get('x-webhook-timestamp');
  
  // Construct signed payload (source-specific)
  const payload = `${timestamp}.${body}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  // Constant-time comparison
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}
```

**Verification patterns:**
- HMAC SHA256 (most common)
- JWT tokens
- API key headers
- Request signing

#### Step 4: Implement Normalization

**Location:** `normalize.ts`

```typescript
import type { NormalizedRecord } from '../../types';
import type { RawWebhook } from './types';

export function normalizeRecord(raw: RawWebhook): NormalizedRecord {
  return {
    // Universal fields
    id: raw.id,
    sourceId: 'source-name',
    type: mapRecordType(raw.type),
    
    // Source-specific data
    data: {
      title: raw.data.attributes.title,
      description: raw.data.attributes.description,
      status: raw.data.attributes.status,
      // ... map other fields
    },
    
    // Relationships
    relationships: extractRelationships(raw),
    
    // Metadata
    metadata: {
      createdAt: new Date(raw.created_at),
      rawType: raw.type,
      sourceUrl: buildSourceUrl(raw),
    },
  };
}

function mapRecordType(sourceType: string): string {
  // Map source types to universal types
  const typeMap: Record<string, string> = {
    'issue': 'issue',
    'pull_request': 'pull-request',
    'comment': 'comment',
  };
  return typeMap[sourceType] || 'unknown';
}

function extractRelationships(raw: RawWebhook) {
  return {
    parent: raw.data.attributes.parent_id,
    author: raw.data.attributes.user_id,
    assignees: raw.data.attributes.assignee_ids || [],
  };
}

function buildSourceUrl(raw: RawWebhook): string {
  return `https://example.com/${raw.data.object}/${raw.id}`;
}
```

#### Step 5: Implement Preview

**Location:** `index.ts`

```typescript
export function previewRecordTypes(): RecordTypePreview[] {
  return [
    {
      type: 'issue',
      label: 'Issues',
      description: 'Project issues and tasks',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'description', type: 'text', required: false },
        { name: 'status', type: 'enum', required: true },
      ],
    },
    {
      type: 'pull-request',
      label: 'Pull Requests',
      description: 'Code review requests',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'branch', type: 'string', required: true },
        { name: 'state', type: 'enum', required: true },
      ],
    },
  ];
}
```

#### Step 6: Main Connector Export

**Location:** `index.ts`

```typescript
import type { Connector } from '../../types';
import { verifyWebhook } from './verify';
import { normalizeRecord } from './normalize';
import { previewRecordTypes } from './preview';

export const sourceNameConnector: Connector = {
  id: 'source-name',
  name: 'Source Name',
  description: 'Connect to Source Name workspace',
  
  // Capabilities
  capabilities: {
    webhook: true,
    poll: false,
    oauth: true,
  },
  
  // Methods
  verifyWebhook,
  normalizeRecord,
  previewRecordTypes,
  
  // OAuth config (if applicable)
  oauth: {
    authorizationUrl: 'https://example.com/oauth/authorize',
    tokenUrl: 'https://example.com/oauth/token',
    scopes: ['read:issues', 'read:prs'],
  },
};
```

#### Step 7: Register Connector

**Location:** `packages/ingestion/src/connectors/types.ts`

```typescript
import { sourceNameConnector } from './source-name';

export const connectors = {
  // ... existing
  'source-name': sourceNameConnector,
};
```

#### Step 8: Write Tests

**Location:** `index.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { sourceNameConnector } from './index';
import { sampleWebhook } from './__fixtures__/webhook.json';

describe('sourceNameConnector', () => {
  describe('verifyWebhook', () => {
    it('accepts valid signature', async () => {
      const req = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'x-webhook-signature': 'valid-sig',
          'x-webhook-timestamp': '1234567890',
        },
        body: JSON.stringify(sampleWebhook),
      });
      
      const valid = await sourceNameConnector.verifyWebhook(
        req,
        'test-secret'
      );
      
      expect(valid).toBe(true);
    });
  });
  
  describe('normalizeRecord', () => {
    it('normalizes issue webhook', () => {
      const normalized = sourceNameConnector.normalizeRecord(sampleWebhook);
      
      expect(normalized.type).toBe('issue');
      expect(normalized.data.title).toBe(sampleWebhook.data.attributes.title);
    });
  });
});
```

### Checklist
- [ ] Connector directory created
- [ ] Types defined (raw + config)
- [ ] Webhook verification implemented
- [ ] Normalization implemented
- [ ] Preview implemented
- [ ] OAuth config (if applicable)
- [ ] Connector registered in types.ts
- [ ] Tests cover verification + normalization
- [ ] Tested with real webhook samples

---

## 6. Writing Tests

### Context
Tests are required for all new code. Coverage thresholds are ratcheted up, never down.

### Prerequisites
- [ ] Code to test written
- [ ] Test type determined (unit vs integration vs E2E)
- [ ] Test data/fixtures prepared

### Procedure

#### Unit Tests

**Location:** Next to source file with `.test.ts` suffix

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { myFunction } from './my-function';

describe('myFunction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  
  it('should handle happy path', () => {
    const result = myFunction({ input: 'test' });
    expect(result).toEqual({ output: 'test-processed' });
  });
  
  it('should throw on invalid input', () => {
    expect(() => myFunction({ input: '' }))
      .toThrow('Input cannot be empty');
  });
  
  it('should handle edge case', () => {
    const result = myFunction({ input: 'special' });
    expect(result.output).toBe('special-handled');
  });
});
```

**Unit test patterns:**
- Test pure logic in isolation
- Mock external dependencies
- Cover happy path + error cases + edge cases
- Fast (milliseconds)

#### Integration Tests

**Location:** Same as unit tests, but suffix with `.integration.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runInTenantScope } from '@oxagen/tenancy';
import { db } from '@oxagen/database';

describe('workspace integration', () => {
  let testWorkspaceId: string;
  
  beforeAll(async () => {
    // Setup test data
    await runInTenantScope({ orgId: 'test' }, async (db) => {
      const [workspace] = await db.insert(workspaces).values({
        name: 'Test Workspace',
      }).returning();
      testWorkspaceId = workspace.id;
    });
  });
  
  afterAll(async () => {
    // Cleanup
    await db.delete(workspaces).where(eq(workspaces.id, testWorkspaceId));
  });
  
  it('should create and fetch workspace', async () => {
    await runInTenantScope({ orgId: 'test', workspaceId: testWorkspaceId }, async (db) => {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, testWorkspaceId),
      });
      
      expect(workspace).toBeDefined();
      expect(workspace.name).toBe('Test Workspace');
    });
  });
});
```

**Integration test patterns:**
- Test real database interactions
- Use test data fixtures
- Clean up after tests
- Slower but more realistic

#### E2E Tests

**Location:** `apps/app/e2e/<feature>.spec.ts`

```typescript
import { test, expect } from '@playwright/test';
import { signIn } from './helpers/auth';

test.describe('Workspace Settings', () => {
  test('should update workspace name', async ({ page }) => {
    // Arrange: Sign in and navigate
    await signIn(page, { email: 'test@example.com' });
    await page.goto('/workspaces/test-workspace/settings');
    
    // Act: Update name
    await page.fill('[name="workspace-name"]', 'New Workspace Name');
    await page.click('button[type="submit"]');
    
    // Assert: Success message + name updated
    await expect(page.locator('[role="alert"]'))
      .toContainText('Workspace updated');
    await expect(page.locator('[data-testid="workspace-name"]'))
      .toContainText('New Workspace Name');
    
    // Screenshot success state (required for UI changes)
    await page.screenshot({
      path: 'screenshots/workspace-settings-updated.png',
    });
  });
  
  test('should show validation error for empty name', async ({ page }) => {
    await signIn(page, { email: 'test@example.com' });
    await page.goto('/workspaces/test-workspace/settings');
    
    await page.fill('[name="workspace-name"]', '');
    await page.click('button[type="submit"]');
    
    await expect(page.locator('[role="alert"]'))
      .toContainText('Name is required');
  });
});
```

**E2E test patterns:**
- Test complete user flows
- Use helpers for common actions (auth, nav)
- Screenshot key success states
- Test both happy + error paths
- Slow (seconds) but high confidence

### Running Tests

```bash
# All unit tests
pnpm test

# Specific file
pnpm test -- my-function.test.ts

# Watch mode
pnpm test -- --watch

# With coverage
pnpm test:coverage

# E2E tests
pnpm test:e2e

# E2E in UI mode (debugging)
pnpm test:e2e -- --ui

# E2E specific test
pnpm test:e2e -- workspace-settings.spec.ts
```

### Coverage Requirements

**Check current thresholds:** `packages/*/vitest.config.ts`

```typescript
export default defineConfig({
  test: {
    coverage: {
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 75,
        lines: 75,
      },
    },
  },
});
```

**Threshold update rule:**
- Only bump when: `floor(new_coverage - 2.5) > current_threshold`
- Example: 77.8% coverage → threshold stays at 75
- Example: 78.5% coverage → bump threshold to 76
- Cap at 90% (diminishing returns)

### Checklist
- [ ] Unit tests for all new functions/handlers
- [ ] Integration tests for database interactions
- [ ] E2E tests for user-facing features
- [ ] Screenshots for UI changes
- [ ] All tests pass locally
- [ ] Coverage thresholds met or increased
- [ ] No `.skip()` or `.only()` in committed tests

---

## 7. Debugging Issues

### Context
Systematic approach to diagnosing and fixing issues.

### Procedure

#### Step 1: Reproduce

```bash
# Collect information
# - What's the error message?
# - What were you doing when it happened?
# - Can you reproduce it consistently?

# Try to reproduce locally
pnpm dev
# Follow steps to trigger issue
```

#### Step 2: Check Logs

```bash
# Application logs
docker logs <container-id>

# Postgres logs
docker logs oxagen-postgres-1

# Neo4j logs
docker logs oxagen-neo4j-1

# ClickHouse logs
docker logs oxagen-clickhouse-1

# Inngest logs
# Visit: http://localhost:8288
```

#### Step 3: Verify Environment

```bash
# Check environment vars
pnpm env:check

# Check DATABASE_URL
echo $DATABASE_URL

# Check connections
pnpm db:check

# Check services
docker ps
```

#### Step 4: Isolate the Problem

**Is it a test failure?**
```bash
# Run specific test
pnpm test -- failing-test.test.ts

# Run with verbose output
pnpm test -- --reporter=verbose

# Run in isolation
pnpm test -- --isolate
```

**Is it a runtime error?**
```typescript
// Add debug logging
import pino from 'pino';
const logger = pino();

logger.debug({ input }, 'Handler called');
logger.error({ error }, 'Handler failed');
```

**Is it a database issue?**
```bash
# Check database state
psql $DATABASE_URL -c "SELECT * FROM workspace.workspaces LIMIT 5"

# Check migrations
pnpm db:atlas-status

# Reset database
pnpm db:reset
pnpm db:migrate
```

#### Step 5: Use Debugger

**VS Code launch.json:**
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Debug API",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["--filter", "@oxagen/api", "dev"],
      "console": "integratedTerminal",
      "restart": true,
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

**Set breakpoints and run debugger**

#### Step 6: Fix and Verify

```bash
# Make fix

# Verify fix works
pnpm test -- affected-test.test.ts

# Run full gate
pnpm gate

# If database-related, verify migration
pnpm db:lint-migrations
pnpm db:atlas-validate
```

#### Step 7: Add Test to Prevent Regression

```typescript
// Add test that would have caught this
it('should handle the case that caused the bug', () => {
  // Reproduce the bug condition
  const result = myFunction({ buggyInput });
  
  // Assert correct behavior
  expect(result).toEqual(expectedOutput);
});
```

### Common Issues & Solutions

#### "Database connection failed"
```bash
# Check Docker
docker ps | grep postgres

# Restart Postgres
docker compose -f docker-compose.dev.yml restart postgres

# Check DATABASE_URL
echo $DATABASE_URL
```

#### "Tenant scope error"
```typescript
// Missing runInTenantScope wrapper
await runInTenantScope({ orgId, workspaceId }, async (db) => {
  // queries here
});
```

#### "Manifest check failed"
```bash
# API and MCP out of sync
# Add capability to MCP or remove from API
pnpm check:manifest
```

#### "Coverage threshold not met"
```bash
# Add tests to increase coverage
pnpm test:coverage

# Or update threshold (only if legitimately increased)
# Edit vitest.config.ts
```

### Checklist
- [ ] Issue reproduced locally
- [ ] Logs checked for errors
- [ ] Environment validated
- [ ] Problem isolated
- [ ] Root cause identified
- [ ] Fix implemented
- [ ] Test added to prevent regression
- [ ] `pnpm gate` passes
- [ ] Documented if novel issue

---

## 8. Performance Optimization

### Context
Systematic approach to finding and fixing performance bottlenecks.

### Procedure

#### Step 1: Measure First

**Never optimize without measuring.**

```bash
# Run with timing
time pnpm test

# Profile tests
pnpm test -- --reporter=verbose --outputFile=test-report.json
```

**In code:**
```typescript
console.time('operation');
await expensiveOperation();
console.timeEnd('operation');
```

#### Step 2: Identify Bottlenecks

**Common bottlenecks:**
- N+1 queries
- Missing indexes
- Large payloads
- Synchronous operations that could be async
- Re-rendering in React

**Database profiling:**
```sql
-- Enable query logging
SET log_statement = 'all';
SET log_duration = on;

-- Analyze slow query
EXPLAIN ANALYZE SELECT * FROM workspace.workspaces WHERE org_id = 'test';
```

#### Step 3: Fix Database Issues

**Add indexes:**
```typescript
// packages/database/src/schema/workspace.ts
export const workspaceOrgIndex = pgIndex('workspace_org_idx')
  .on(workspaces.orgId);
```

**Fix N+1 queries:**
```typescript
// ❌ N+1 query
for (const workspace of workspaces) {
  const members = await db.query.members.findMany({
    where: eq(members.workspaceId, workspace.id),
  });
}

// ✅ Single query with join
const workspaces = await db.query.workspaces.findMany({
  with: {
    members: true,
  },
});
```

**Use select to limit fields:**
```typescript
// ❌ Fetches all columns
const workspaces = await db.query.workspaces.findMany();

// ✅ Only needed columns
const workspaces = await db.select({
  id: workspaces.id,
  name: workspaces.name,
}).from(workspaces);
```

#### Step 4: Fix API Issues

**Cache responses:**
```typescript
import { cache } from 'react';

// Next.js request memoization
export const getWorkspace = cache(async (id: string) => {
  return await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
  });
});
```

**Stream large responses:**
```typescript
// Instead of returning huge JSON
export async function handler(input: Input) {
  const stream = new ReadableStream({
    async start(controller) {
      for await (const chunk of largeDataset) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  
  return new Response(stream);
}
```

**Use pagination:**
```typescript
// ❌ Fetch all
const workspaces = await db.query.workspaces.findMany();

// ✅ Paginate
const workspaces = await db.query.workspaces.findMany({
  limit: 20,
  offset: input.page * 20,
});
```

#### Step 5: Fix React Issues

**Memoize expensive computations:**
```typescript
import { useMemo } from 'react';

function MyComponent({ data }) {
  const processed = useMemo(() => {
    return expensiveTransform(data);
  }, [data]);
  
  return <div>{processed}</div>;
}
```

**Avoid unnecessary re-renders:**
```typescript
import { memo } from 'react';

const MyComponent = memo(({ data }) => {
  return <div>{data}</div>;
});
```

**Use useCallback for callbacks:**
```typescript
import { useCallback } from 'react';

function MyComponent() {
  const handleClick = useCallback(() => {
    doSomething();
  }, []);
  
  return <button onClick={handleClick}>Click</button>;
}
```

#### Step 6: Measure Again

```bash
# Verify improvement
time pnpm test

# Compare before/after
```

**Database query:**
```sql
-- Compare execution time
EXPLAIN (ANALYZE, BUFFERS) 
SELECT * FROM workspace.workspaces WHERE org_id = 'test';
```

#### Step 7: Document

```typescript
// Add comment explaining optimization
/**
 * Uses index workspace_org_idx for fast lookup by org_id.
 * Benchmarked: 150ms → 5ms for 10k workspaces.
 */
```

### Checklist
- [ ] Performance issue measured (before)
- [ ] Bottleneck identified
- [ ] Fix implemented
- [ ] Performance measured (after)
- [ ] Improvement verified (benchmark saved)
- [ ] Tests still pass
- [ ] Optimization documented
- [ ] `pnpm gate` passes

---

## Appendix: Quick Reference

### File Patterns
- Capabilities: `packages/oxagen/src/contracts/<name>.ts`
- Handlers: `packages/handlers/src/<name>.ts`
- Tests: `<file>.test.ts` (next to source)
- E2E: `apps/app/e2e/<feature>.spec.ts`
- Schema: `packages/database/src/schema/<domain>.ts`
- Migrations: Auto-generated in `packages/database/atlas/migrations/`

### Common Commands
```bash
pnpm dev                  # Start dev environment
pnpm gate                 # Full verification
pnpm test                 # Unit tests
pnpm test:e2e            # E2E tests
pnpm db:migrate:diff     # Create migration
pnpm check:manifest      # API/MCP parity
```

### Import Patterns
```typescript
// ✅ Correct
import { Button } from '@/components/ui/button';
import { invoke } from '@oxagen/oxagen';
import { runInTenantScope } from '@oxagen/tenancy';

// ❌ Forbidden
import { Button } from '@oxagen/ui/components/button';
```

### Test Patterns
```typescript
// Setup
beforeEach(() => {
  clearHandlersForTests();
  clearBillingAdmissionGate();
});

// Tenant scope in tests
await runInTenantScope({ orgId, workspaceId }, async (db) => {
  // queries
});
```
