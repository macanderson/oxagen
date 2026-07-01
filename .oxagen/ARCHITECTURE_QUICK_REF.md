# Architecture Quick Reference

**Purpose:** Fast lookup for architectural decisions, patterns, and boundaries.

---

## System Architecture

### Core Principle

**Single Source of Truth:** Every feature is a capability contract in `packages/oxagen`, invoked through one kernel, exposed identically across all surfaces.

```
┌─────────────────────────────────────────────────────────┐
│                    CAPABILITY KERNEL                     │
│                  packages/oxagen/kernel.ts               │
│                                                          │
│  invoke(name, input) → validate → check IAM →           │
│    → check billing → check plugin → dispatch handler    │
│    → validate output → log telemetry → return           │
└─────────────────────────────────────────────────────────┘
           ▲              ▲              ▲              ▲
           │              │              │              │
    ┌──────┴──────┐ ┌────┴─────┐ ┌─────┴─────┐ ┌──────┴──────┐
    │   API       │ │   MCP    │ │   Agent   │ │    CLI      │
    │  (Hono)     │ │ (xmcp)   │ │ (runtime) │ │ (Commander) │
    └─────────────┘ └──────────┘ └───────────┘ └─────────────┘
```

---

## Storage Boundaries (CRITICAL)

### Three-Store Architecture

```
┌─────────────────────┐  ┌─────────────────────┐  ┌─────────────────────┐
│    POSTGRESQL       │  │       NEO4J         │  │    CLICKHOUSE       │
│  Transactional DB   │  │  Knowledge Graph    │  │  Analytics Store    │
├─────────────────────┤  ├─────────────────────┤  ├─────────────────────┤
│ ✅ Users            │  │ ✅ Entities         │  │ ✅ Audit events     │
│ ✅ Orgs             │  │ ✅ Relationships    │  │ ✅ Token usage      │
│ ✅ Workspaces       │  │ ✅ Agent memory     │  │ ✅ Telemetry        │
│ ✅ Billing          │  │ ✅ Lineage          │  │ ✅ Metrics          │
│ ✅ IAM roles/perms  │  │ ✅ Embeddings       │  │                     │
│ ✅ Config           │  │ ✅ Graph queries    │  │                     │
│ ✅ Connectors       │  │                     │  │                     │
├─────────────────────┤  ├─────────────────────┤  ├─────────────────────┤
│ ❌ Analytics        │  │ ❌ Transactional    │  │ ❌ Mutable state    │
│ ❌ Graph data       │  │ ❌ User accounts    │  │ ❌ Config           │
│ ❌ Append-only logs │  │ ❌ Billing          │  │ ❌ Relationships    │
└─────────────────────┘  └─────────────────────┘  └─────────────────────┘
```

### Storage Decision Matrix

| Data Type                         | PostgreSQL | Neo4j | ClickHouse |
| --------------------------------- | ---------- | ----- | ---------- |
| User accounts                     | ✅         | ❌    | ❌         |
| Org/Workspace state               | ✅         | ❌    | ❌         |
| IAM roles/permissions             | ✅         | ❌    | ❌         |
| Billing ledger                    | ✅         | ❌    | ❌         |
| Configuration                     | ✅         | ❌    | ❌         |
| Entities (people, files, tickets) | ❌         | ✅    | ❌         |
| Relationships/edges               | ❌         | ✅    | ❌         |
| Agent memory/context              | ❌         | ✅    | ❌         |
| Execution lineage                 | ❌         | ✅    | ❌         |
| Vector embeddings                 | ❌         | ✅    | ❌         |
| Audit events                      | ❌         | ❌    | ✅         |
| Token usage                       | ❌         | ❌    | ✅         |
| Performance metrics               | ❌         | ❌    | ✅         |
| Time-series data                  | ❌         | ❌    | ✅         |

---

## Package Architecture

### Dependency Layers

```
┌─────────────────────────────────────────────────────────┐
│                     APPLICATIONS                         │
│  apps/api, apps/app, apps/mcp, apps/cli, apps/docs     │
└──────────────────────┬──────────────────────────────────┘
                       │ depends on
┌──────────────────────▼──────────────────────────────────┐
│                   ORCHESTRATION                          │
│  agent, inngest-functions, functions                    │
└──────────────────────┬──────────────────────────────────┘
                       │ depends on
┌──────────────────────▼──────────────────────────────────┐
│                    CAPABILITIES                          │
│  oxagen (kernel), handlers, plugins, skills             │
└──────────────────────┬──────────────────────────────────┘
                       │ depends on
┌──────────────────────▼──────────────────────────────────┐
│                    DOMAIN LOGIC                          │
│  ingestion, billing, iam, sandbox, notifications        │
└──────────────────────┬──────────────────────────────────┘
                       │ depends on
┌──────────────────────▼──────────────────────────────────┐
│                  INFRASTRUCTURE                          │
│  database, ontology, telemetry, auth, storage           │
└──────────────────────┬──────────────────────────────────┘
                       │ depends on
┌──────────────────────▼──────────────────────────────────┐
│                   FOUNDATIONS                            │
│  config, tenancy, compliance, crypto, ai, ui            │
└─────────────────────────────────────────────────────────┘
```

**Rule:** Lower layers never depend on upper layers.

### Package Dependency Matrix

| Package      | Depends On                         | Used By                  |
| ------------ | ---------------------------------- | ------------------------ |
| **config**   | -                                  | Everything               |
| **tenancy**  | config                             | database, handlers, apps |
| **database** | config, tenancy, telemetry         | handlers, apps           |
| **oxagen**   | config, tenancy                    | Everything               |
| **handlers** | oxagen, database, all domains      | apps                     |
| **agent**    | oxagen, handlers, database         | apps/api, apps/app       |
| **apps/api** | handlers, agent, inngest-functions | -                        |
| **apps/mcp** | oxagen, handlers                   | -                        |

---

## Tenancy Architecture

### Multi-Tenant Hierarchy

```
Organization (org_id)
  ├─ Users (org-scoped)
  ├─ Workspaces (workspace_id)
  │   ├─ Agents (workspace-scoped)
  │   ├─ Chats (workspace-scoped)
  │   ├─ Connectors (workspace-scoped)
  │   └─ Knowledge Graph (workspace-scoped)
  └─ Billing (org-scoped)
```

### Scope Enforcement

**PostgreSQL:** Row-Level Security (RLS) policies

```sql
-- Org-scoped table
CREATE TABLE org.organizations (
  id text PRIMARY KEY,
  -- RLS policy: current_org_id() = id
);

-- Workspace-scoped table
CREATE TABLE workspace.workspaces (
  id text PRIMARY KEY,
  org_id text REFERENCES org.organizations(id),
  -- RLS policy: current_workspace_id() = id AND current_org_id() = org_id
);
```

**Application Code:** `runInTenantScope` wrapper

```typescript
import { runInTenantScope } from '@oxagen/tenancy';

// REQUIRED for all DB queries in scoped capabilities
await runInTenantScope({ orgId, workspaceId }, async (db) => {
  // All queries here are automatically scoped
  const workspaces = await db.query.workspaces.findMany();
  // Only returns workspaces for this org/workspace
});
```

**Neo4j:** Predicate injection

```cypher
// All queries include tenant filter
MATCH (n:Entity)
WHERE n.orgId = $orgId AND n.workspaceId = $workspaceId
RETURN n
```

**ClickHouse:** Query-time filtering

```sql
-- All queries filtered by tenant
SELECT * FROM events
WHERE org_id = {org_id:String}
  AND workspace_id = {workspace_id:String}
```

---

## IAM Architecture

### Policy Resolution Flow

```
invoke(capability, input, context)
  │
  ├─ Extract: orgId, workspaceId, userId from context
  │
  ├─ Check capability.defaultEffect
  │   └─ If "allow" → ALLOW (skip IAM check)
  │   └─ If "deny" → continue
  │
  ├─ Fetch user roles
  │   ├─ Org roles (e.g., Owner, Admin, Member)
  │   └─ Workspace roles (e.g., Admin, Member, Viewer)
  │
  ├─ Fetch capability grants (overrides)
  │   ├─ Org-level grants: org_capability_grants
  │   └─ Workspace-level grants: workspace_capability_grants
  │
  ├─ Apply precedence rules:
  │   1. Explicit deny at workspace level → DENY
  │   2. Explicit allow at workspace level → ALLOW
  │   3. Explicit deny at org level → DENY
  │   4. Explicit allow at org level → ALLOW
  │   5. defaultRoles for workspace role → ALLOW/DENY
  │   6. defaultRoles for org role → ALLOW/DENY
  │   7. capability.defaultEffect → ALLOW/DENY
  │
  └─ Return decision + log to ClickHouse
```

### Role Hierarchy

```
Organization Roles:
  Owner (highest)
    ├─ All permissions
    └─ Billing management

  Admin
    ├─ User management
    ├─ Workspace creation
    └─ Settings

  Member (lowest)
    └─ Read-only org info

Workspace Roles:
  Admin
    ├─ All workspace operations
    ├─ User management
    └─ Settings

  Member
    ├─ Chat operations
    ├─ Agent interactions
    └─ Connector usage

  Viewer (lowest)
    └─ Read-only access
```

---

## Capability System

### Capability Contract Structure

```typescript
defineContract({
  // Unique identifier (dot notation)
  name: 'domain.feature.action',

  // Input/output schemas (Zod)
  input: z.object({
    /* ... */
  }),
  output: z.object({
    /* ... */
  }),

  // Where exposed
  surfaces: ['api', 'mcp', 'agent', 'cli'],

  // IAM defaults
  defaultEffect: 'deny', // or 'allow'
  sensitivity: 'medium', // 'low' | 'medium' | 'high'

  // Billing
  noBillingGate: false, // true = skip credit check

  // Default permissions
  defaultRoles: {
    org: {
      Owner: 'allow',
      Admin: 'allow',
      Member: 'deny',
    },
    workspace: {
      Admin: 'allow',
      Member: 'allow',
      Viewer: 'deny',
    },
  },

  // Metadata
  description: 'Human-readable description',
  tags: ['category', 'feature'],
});
```

### Surface Mapping

| Surface   | Entry Point               | Protocol         | Use Case                               |
| --------- | ------------------------- | ---------------- | -------------------------------------- |
| **api**   | `apps/api/src/routes/v1/` | HTTP REST        | Web app, mobile, external integrations |
| **mcp**   | `apps/mcp/src/tools/`     | MCP (stdio/HTTP) | IDE plugins, Claude Desktop, agents    |
| **agent** | `packages/agent/src/`     | Internal         | AI agent tool dispatch                 |
| **cli**   | `apps/cli/src/commands/`  | Commander        | Terminal, scripts, CI/CD               |

### Handler Registration

```typescript
// packages/handlers/src/register.ts

// Lazy loaded (not imported until invoked)
registerHandler('capability.name', async () => {
  const { handler } = await import('./capability-name');
  return handler;
});
```

**Why lazy?** Keeps kernel startup fast, avoids loading heavy dependencies upfront.

---

## Data Flow Patterns

### Synchronous (Request/Response)

```
User Request → API/MCP/CLI
  ↓
Kernel.invoke()
  ↓ validate input
  ↓ check IAM
  ↓ check billing
  ↓ check plugin entitlement
  ↓
Handler
  ↓ runInTenantScope()
  ↓ query database
  ↓ business logic
  ↓
Response ← validate output
```

### Asynchronous (Background Jobs)

```
Handler
  ↓
inngest.send(event)
  ↓
Inngest Function
  ↓ step 1: check idempotency
  ↓ step 2: process
  ↓ step 3: update state
  ↓ step 4: fan-out (optional)
  ↓
Complete
```

### Ingestion Pipeline

```
Webhook/Poll
  ↓
Connector.verify()
  ↓
Connector.normalize()
  ↓
Pipeline
  ├─ Postgres: raw records
  ├─ Neo4j: entities + relationships
  └─ Inngest: enrichment jobs
       ↓
Enrichment Workers
  ├─ Extract entities
  ├─ Infer relationships
  └─ Embed content
       ↓
Neo4j: enriched graph
```

---

## Database Schema Organization

### PostgreSQL Schemas

```
├─ auth           # Better Auth tables
├─ org            # Organization-scoped
│   ├─ organizations
│   ├─ org_users
│   ├─ org_roles
│   └─ org_capability_grants
│
├─ workspace      # Workspace-scoped
│   ├─ workspaces
│   ├─ workspace_users
│   ├─ workspace_roles
│   └─ workspace_capability_grants
│
├─ chat           # Chat/message data
│   ├─ chats
│   ├─ messages
│   └─ message_attachments
│
├─ agent          # Agent definitions
│   ├─ agents
│   ├─ agent_runs
│   └─ agent_tools
│
├─ ingestion      # Connector state
│   ├─ connectors
│   ├─ connector_configs
│   └─ ingestion_runs
│
├─ billing        # Stripe integration
│   ├─ stripe_customers
│   ├─ stripe_subscriptions
│   └─ usage_events
│
├─ iam            # IAM policies
│   ├─ roles
│   ├─ permissions
│   └─ grants
│
├─ mcp            # MCP configuration
│   ├─ mcp_servers
│   └─ mcp_consents
│
├─ notification   # Email/notifications
│   ├─ notifications
│   └─ notification_preferences
│
├─ plugin         # Plugin marketplace
│   ├─ plugins
│   ├─ plugin_installations
│   └─ plugin_entitlements
│
├─ privacy        # GDPR compliance
│   ├─ erasure_requests
│   └─ consent_records
│
├─ security       # Security events
│   ├─ audit_logs
│   └─ security_events
│
└─ workflow       # Orchestration state
    ├─ workflows
    └─ workflow_executions
```

### Neo4j Node Labels

```
(:Organization) - Org entity
(:Workspace) - Workspace entity
(:User) - User entity
(:Agent) - Agent entity
(:Chat) - Chat entity
(:Message) - Message entity
(:Entity) - Generic entity (from connectors)
  ├─ (:Person)
  ├─ (:File)
  ├─ (:Ticket)
  ├─ (:Repository)
  └─ (:Document)
(:Memory) - Agent memory
(:Capability) - Capability metadata
(:Tool) - Tool definition
```

### Neo4j Relationship Types

```
(:User)-[:BELONGS_TO]->(:Organization)
(:User)-[:MEMBER_OF]->(:Workspace)
(:Agent)-[:DEPLOYED_IN]->(:Workspace)
(:Agent)-[:HAS_TOOL]->(:Tool)
(:Message)-[:SENT_BY]->(:User)
(:Message)-[:IN_CHAT]->(:Chat)
(:Entity)-[:RELATED_TO]->(:Entity)
(:Agent)-[:REMEMBERS]->(:Memory)
(:Tool)-[:IMPLEMENTS]->(:Capability)
```

### ClickHouse Tables

```
events              # All audit events
├─ event_time       # Timestamp
├─ org_id           # Tenant filter
├─ workspace_id     # Tenant filter
├─ user_id          # Actor
├─ capability_name  # What was invoked
├─ event_type       # success, error, denied
└─ metadata         # JSON payload

token_usage         # LLM token consumption
├─ timestamp
├─ org_id
├─ workspace_id
├─ model
├─ input_tokens
├─ output_tokens
└─ cost_usd

metrics             # Performance metrics
├─ timestamp
├─ metric_name
├─ value
└─ tags (JSON)
```

---

## Agent Architecture

### Agent Execution Flow

```
User Message
  ↓
Agent Runtime
  ├─ Load agent definition
  ├─ Build system prompt
  ├─ Materialize tool list (filtered by IAM)
  │   └─ Only capabilities user can invoke
  ├─ Add chat history (last N messages)
  └─ Call LLM with streaming
      ↓
LLM Response (streamed)
  ├─ Text chunks → stream to client
  ├─ Tool calls → execute via kernel
  │   └─ invoke(capability, args, context)
  │       ├─ Validate
  │       ├─ Check IAM (already filtered)
  │       ├─ Execute
  │       └─ Return result
  ├─ Tool results → back to LLM
  └─ Final response → stream to client
```

### Tool Materialization

```typescript
// packages/agent/src/runtime/materialize-tools.ts

async function materializeTools(context) {
  // Get all capabilities for this agent
  const capabilities = getAgentCapabilities(context.agentId);

  // Filter by IAM permissions
  const allowed = [];
  for (const cap of capabilities) {
    const decision = await resolveIAM(cap.name, context);
    if (decision.allowed) {
      allowed.push(cap);
    }
  }

  // Convert to LLM tool format
  return allowed.map((cap) => ({
    type: 'function',
    function: {
      name: cap.name,
      description: cap.description,
      parameters: zodToJsonSchema(cap.input),
    },
  }));
}
```

**Key insight:** Tool list is dynamically filtered per user, enforcing IAM at the tool level.

---

## Billing Architecture

### Credit-Based Metering

```
User Action → invoke(capability)
  ↓
If capability.noBillingGate === false:
  ↓
  Check credit balance
    ├─ Fetch org subscription
    ├─ Fetch current usage
    └─ Calculate remaining credits
  ↓
  If credits < threshold:
    └─ DENY (BillingError)
  ↓
  Execute capability
  ↓
  Record usage:
    ├─ Postgres: usage_events
    └─ ClickHouse: token_usage
```

### Pricing Model

```typescript
// Token cost formula
const baseCost =
  inputTokens * modelInputPrice + outputTokens * modelOutputPrice;
const margin = baseCost * OXAGEN_TARGET_MARGIN;
const markupPercent = OXAGEN_METER_MARKUP;
const finalCost = (baseCost + margin) * (1 + markupPercent);

// Discount tiers (usage-based)
const discount = min(
  (totalSpendUSD / OXAGEN_USAGE_DISCOUNT_INCREMENT) *
    OXAGEN_USAGE_DISCOUNT_PERCENT,
  OXAGEN_USAGE_DISCOUNT_CEILING_USD,
);

const chargeAmount = finalCost - discount;
```

---

## Testing Architecture

### Test Pyramid

```
        ┌─────┐
        │ E2E │  (10%)  Full browser, slow, high confidence
        └─────┘
      ┌─────────┐
      │  Integ  │  (20%)  Real DB, cross-package, medium speed
      └─────────┘
   ┌──────────────┐
   │     Unit     │  (70%)  Isolated, mocked, fast
   └──────────────┘
```

### Test File Locations

| Test Type       | Location        | Filename Pattern             |
| --------------- | --------------- | ---------------------------- |
| **Unit**        | Next to source  | `<file>.test.ts`             |
| **Integration** | Next to source  | `<file>.integration.test.ts` |
| **E2E**         | `apps/app/e2e/` | `<feature>.spec.ts`          |

### Test Setup Patterns

```typescript
import { beforeEach } from 'vitest';
import { clearHandlersForTests } from '@oxagen/oxagen';
import { clearBillingAdmissionGate } from '@oxagen/billing';

beforeEach(() => {
  // Reset kernel state
  clearHandlersForTests();

  // Reset billing gate
  clearBillingAdmissionGate();

  // Other resets as needed
});
```

---

## Security Patterns

### Authentication Flow

```
User Login
  ↓
Better Auth
  ├─ Email/password
  ├─ OAuth (Google, GitHub)
  └─ Passkeys (WebAuthn)
  ↓
Session Cookie (JWT)
  ├─ Signed with BETTER_AUTH_SECRET
  ├─ HttpOnly, Secure, SameSite=Lax
  └─ Contains: userId, sessionId
  ↓
Middleware verifies session
  ↓
Context populated: { userId, orgId, workspaceId }
```

### Authorization Flow

```
Request with context
  ↓
Capability invoked
  ↓
IAM.resolve(capabilityName, context)
  ├─ Extract roles
  ├─ Check grants
  ├─ Apply precedence
  └─ Return ALLOW/DENY
  ↓
If DENY → 403 Forbidden
If ALLOW → continue
```

### Data Encryption

**At Rest:**

- PostgreSQL: TDE (Transparent Data Encryption)
- Backups: AES-256
- Secrets: Encrypted in `.env.local` (dev) or Vercel (prod)

**In Transit:**

- HTTPS (TLS 1.3)
- Database connections: SSL required

**Application-Level:**

```typescript
import { encrypt, decrypt } from '@oxagen/crypto';

// Encrypt sensitive fields before storage
const encrypted = await encrypt(sensitiveData, key);
await db.insert(table).values({ data: encrypted });

// Decrypt on read
const row = await db.query.table.findFirst();
const decrypted = await decrypt(row.data, key);
```

---

## Performance Patterns

### Database Query Optimization

```typescript
// ❌ N+1 query
for (const workspace of workspaces) {
  const members = await db.query.members.findMany({
    where: eq(members.workspaceId, workspace.id),
  });
}

// ✅ Single query with join
const workspaces = await db.query.workspaces.findMany({
  with: { members: true },
});

// ✅ Batch query
const workspaceIds = workspaces.map((w) => w.id);
const allMembers = await db.query.members.findMany({
  where: inArray(members.workspaceId, workspaceIds),
});
```

### Caching Strategy

```typescript
// Next.js request memoization (per-request cache)
import { cache } from 'react';

export const getWorkspace = cache(async (id: string) => {
  return await db.query.workspaces.findFirst({
    where: eq(workspaces.id, id),
  });
});

// Multiple calls in same request → only one DB query
const w1 = await getWorkspace('id');
const w2 = await getWorkspace('id'); // cached
```

### Streaming Responses

```typescript
// Server Component with streaming
export async function MyComponent() {
  return (
    <Suspense fallback={<Skeleton />}>
      <DataComponent />
    </Suspense>
  );
}

async function DataComponent() {
  const data = await fetchData(); // Streamed when ready
  return <div>{data}</div>;
}
```

---

## Deployment Architecture

### Vercel Deployment

```
apps/
├─ api/       → Vercel Serverless Function
├─ app/       → Vercel Edge/Node
├─ mcp/       → Vercel Serverless Function
├─ cli/       → npm package
└─ docs/      → Static site

External Services:
├─ PostgreSQL → Vercel Postgres or Supabase
├─ Neo4j      → Aura or self-hosted
├─ ClickHouse → ClickHouse Cloud
├─ Inngest    → Inngest Cloud
└─ Stripe     → Stripe API
```

### Environment Variables by Service

| Variable           | API | App | MCP | CLI |
| ------------------ | --- | --- | --- | --- |
| DATABASE_URL       | ✅  | ✅  | ✅  | ❌  |
| NEO4J_URI          | ✅  | ✅  | ✅  | ❌  |
| CLICKHOUSE_URL     | ✅  | ✅  | ❌  | ❌  |
| BETTER_AUTH_SECRET | ✅  | ✅  | ❌  | ❌  |
| STRIPE_SECRET_KEY  | ✅  | ❌  | ❌  | ❌  |
| INNGEST_EVENT_KEY  | ✅  | ❌  | ❌  | ❌  |
| AI_GATEWAY_API_KEY | ✅  | ✅  | ✅  | ✅  |

---

## Common Patterns Cheat Sheet

### Capability Handler Template

```typescript
import type { InferInput, InferOutput } from '@oxagen/oxagen';
import { myCapability } from '@oxagen/oxagen/contracts';
import { runInTenantScope } from '@oxagen/tenancy';

type Input = InferInput<typeof myCapability>;
type Output = InferOutput<typeof myCapability>;

export async function handler(input: Input): Promise<Output> {
  return await runInTenantScope(
    { orgId: input.orgId, workspaceId: input.workspaceId },
    async (db) => {
      // Implementation
    },
  );
}
```

### Database Query Template

```typescript
import { eq, and } from 'drizzle-orm';
import { workspaces } from '@oxagen/database/schema';

// Find one
const workspace = await db.query.workspaces.findFirst({
  where: eq(workspaces.id, workspaceId),
});

// Find many with relations
const workspaces = await db.query.workspaces.findMany({
  with: {
    members: true,
    agents: true,
  },
});

// Insert
const [newWorkspace] = await db
  .insert(workspaces)
  .values({ name: 'New Workspace' })
  .returning();

// Update
await db
  .update(workspaces)
  .set({ name: 'Updated Name' })
  .where(eq(workspaces.id, workspaceId));

// Delete
await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
```

### React Server Component Template

```typescript
import { Suspense } from 'react';

export default async function Page({ params }) {
  return (
    <div>
      <Header />
      <Suspense fallback={<Skeleton />}>
        <DataComponent params={params} />
      </Suspense>
    </div>
  );
}

async function DataComponent({ params }) {
  const data = await fetchData(params.id);
  return <div>{data}</div>;
}
```

---

## ADR Quick Reference

| ADR                                                                 | Decision                 | Rationale                                   |
| ------------------------------------------------------------------- | ------------------------ | ------------------------------------------- |
| [001](../docs/adr/ADR-001-drizzle-as-postgres-orm.md)               | Drizzle ORM              | Type-safe, minimal runtime, migration-first |
| [002](../docs/adr/ADR-002-inngest-as-job-orchestration.md)          | Inngest for jobs         | Durable, observable, retryable workflows    |
| [003](../docs/adr/ADR-003-neo4j-as-vector-store.md)                 | Neo4j for graph          | Graph queries + vectors in one store        |
| [004](../docs/adr/ADR-004-env-vars-not-secret-manager.md)           | Env vars                 | Simpler, portable, version-controlled       |
| [005](../docs/adr/ADR-005-single-version-monorepo.md)               | Single version           | Eliminates version drift, simpler CI        |
| [006](../docs/adr/ADR-006-better-auth-bound-to-canonical-users.md)  | Better Auth              | Auth tables bound to canonical users        |
| [007](../docs/adr/ADR-007-docker-as-code-sandbox.md)                | Docker sandbox           | Vendor-neutral, portable                    |
| [009](../docs/adr/ADR-009-unified-capability-tool-model.md)         | Unified capability model | Single source of truth, no drift            |
| [012](../docs/adr/ADR-012-connector-dual-write-pattern.md)          | Dual-write pattern       | Postgres + Neo4j consistency                |
| [015](../docs/adr/ADR-015-graph-edge-driven-git-hooks-and-biome.md) | Import-graph hooks       | Only test affected code                     |

---

## Quick Debugging Checklist

### Issue: "Database connection failed"

```bash
docker ps | grep postgres
docker logs oxagen-postgres-1
echo $DATABASE_URL
pnpm env:check
```

### Issue: "Tenant scope error"

```typescript
// Missing wrapper
await runInTenantScope({ orgId, workspaceId }, async (db) => {
  // queries here
});
```

### Issue: "Manifest check failed"

```bash
pnpm check:manifest
# Add capability to MCP or adjust surfaces
```

### Issue: "Coverage dropped"

```bash
pnpm test:coverage
# Add tests or update threshold
```

### Issue: "Build failed"

```bash
pnpm clean:cache
rm -rf node_modules/.cache
pnpm install --force
pnpm build
```

---

## Version: 0.5.0

**Last Updated:** June 2024
