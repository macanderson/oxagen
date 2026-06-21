# Architecture

## Overview

Oxagen is an enterprise AI platform built on a **capability kernel** pattern. Every user action, API call, MCP tool invocation, and agent action flows through a single `invoke()` function in `packages/oxagen/src/kernel.ts`. Capabilities are defined once and exposed identically across all surfaces.

## Capability Kernel

```mermaid
flowchart TD
    A["Surface Entry\n(API / MCP / App / CLI)"] --> B["kernel.invoke(name, input, ctx)"]
    B --> C{"Contract\nregistered?"}
    C -- No --> ERR1["CapabilityError\nunknown_capability"]
    C -- Yes --> D{"Surface\nallowed?"}
    D -- No --> ERR2["CapabilityError\nsurface_denied"]
    D -- Yes --> E["Zod input.safeParse"]
    E -- Fail --> ERR3["CapabilityError\ninvalid_input"]
    E -- Pass --> F["IAM Gate\n(_iamCheckFn)"]
    F -- Deny + enforced --> ERR4["CapabilityError\nauthz_denied"]
    F -- Allow --> G["Billing Gate\n(_billingGate)"]
    G -- Suspended/No credits --> ERR5["BillingSuspendedError\nInsufficientCreditsError"]
    G -- Pass --> H["Entitlement Gate\n(_entitlementGate)"]
    H -- Not installed --> ERR6["CapabilityError\ncapability_not_installed"]
    H -- Pass --> I["Handler fn(input, ctx)"]
    I --> J["Zod output.safeParse"]
    J -- Fail --> ERR7["CapabilityError\ninvalid_output"]
    J -- Pass --> K["KernelSecurityEvent emit\n(fire-and-forget)"]
    K --> L["Return output"]
```

The three gates — IAM, billing, entitlement — are **injected** at surface bootstrap. The kernel has no static imports from `@oxagen/billing`, `@oxagen/iam`, or `@oxagen/plugins`. Tests can omit any gate.

> **Decision:** Tools ARE capabilities — a single registry exposes the same handler across `api`/`mcp`/`agent` surfaces via the `surfaces` field, rather than a separate tool registry. See [ADR-009 — Unified capability/tool model via `surfaces`](../../docs/adr/ADR-009-unified-capability-tool-model.md). The entitlement gate that fronts installable capability packs is [ADR-013 — Oxagen Plugins](../../docs/adr/ADR-013-oxagen-plugins-capability-packs.md).

## Single Source of Truth Pattern

```mermaid
graph TB
    SOT["packages/oxagen\nCapability Contracts\n(defineContract + Zod schemas)"]

    SOT --> API["apps/api\nHono routes\n/v1/*"]
    SOT --> MCP["apps/mcp\nMCP tool definitions"]
    SOT --> APP["apps/app\nServer actions\n+ streaming route"]
    SOT --> CLI["apps/cli\n108 commands"]

    H["packages/handlers\nBuilt-in implementations"]
    AG["packages/agent\nAgent-surface handlers"]

    SOT --> H
    SOT --> AG

    GATE["pnpm check:manifest\nDrift guard: API ↔ MCP parity"]
    SOT -.-> GATE
```

The `check:manifest` script enforces that every capability present on the `api` surface also exists on the `mcp` surface. `check:contracts` enforces that every contract file is imported from the barrel index.

## Data Storage Boundaries

```mermaid
graph LR
    subgraph "Transactional State"
        PG["PostgreSQL 16\n16 domain schemas\nUsers, Orgs, Billing\nConfig, IAM, Ingestion"]
    end
    subgraph "Knowledge Graph"
        NEO["Neo4j 5+\nOntology nodes & edges\nExecution lineage\nAgent memory\nInferred entities"]
    end
    subgraph "Append-only Events"
        CH["ClickHouse\nSecurity audit events\nToken usage / billing\nAgent telemetry\nRuntime metrics"]
    end
    subgraph "Assets"
        VB["Vercel Blob\nImages, files\nSigned URLs"]
    end
```

**Hard rule**: never put graph relationships in Postgres; never put analytics in Neo4j; never put ACID state in ClickHouse.

> **Decisions:** [ADR-001 — Drizzle as Postgres ORM](../../docs/adr/ADR-001-drizzle-as-postgres-orm.md), [ADR-003 — Neo4j as vector store](../../docs/adr/ADR-003-neo4j-as-vector-store.md), [ADR-012 — Connector dual-write to Postgres + Neo4j](../../docs/adr/ADR-012-connector-dual-write-pattern.md).

## Surface Architecture

```mermaid
graph TB
    USER["User / Client"]

    subgraph "Surfaces"
        HTTPS["HTTP API\napps/api\nHono + RLS middleware"]
        MCPS["MCP Server\napps/mcp\nStreamable HTTP"]
        APPS["Web App\napps/app\nNext.js RSC + server actions"]
        CLIS["CLI\napps/cli\nCommander + Ink"]
    end

    subgraph "Kernel"
        K["kernel.invoke()\npackages/oxagen"]
        HANDLERS["packages/handlers"]
        AGENT["packages/agent"]
    end

    USER --> HTTPS
    USER --> MCPS
    USER --> APPS
    USER --> CLIS

    HTTPS --> K
    MCPS --> K
    APPS --> K
    CLIS --> K

    K --> HANDLERS
    K --> AGENT
```

## Multi-tenancy

Row-Level Security is enforced at the Postgres driver level via `packages/tenancy`. Every scoped capability call wraps its DB queries in `runInTenantScope({ orgId, workspaceId })`. The RLS role is provisioned by `tools/scripts/provision-rls-role.ts` and all tenant-specific queries receive predicates via `withTenantDb`.

> **Decision:** Identity is bound to a canonical `auth.users` table that Better Auth adapts onto — see [ADR-006 — Better Auth bound to canonical `auth.users`](../../docs/adr/ADR-006-better-auth-bound-to-canonical-users.md). MCP registries are workspace-scoped with a single-default state machine ([ADR-014](../../docs/adr/ADR-014-workspace-scoped-mcp-registry-single-default.md)).

## Agent Runtime

```mermaid
sequenceDiagram
    participant Chat as Chat (app/api)
    participant Kernel as kernel.invoke
    participant Agent as packages/agent
    participant Tools as materialize-tools
    participant MCP as External MCP
    participant Neo4j as Neo4j

    Chat->>Kernel: invoke("chat.message.send")
    Kernel->>Agent: streamAgentReply(ctx)
    Agent->>Tools: materializeTools(ctx)
    Tools-->>Agent: tool list (built-in + MCP)
    loop LLM reasoning loop
        Agent->>Kernel: invoke(capabilityName, ...)
        Agent->>MCP: call external tool (authorized via authorizeExternalCapability)
    end
    Agent->>Neo4j: recordExecutionInGraph (lineage)
    Agent-->>Chat: stream complete
```

## Background Job Architecture

Inngest (`packages/inngest-functions`) provides durable, retryable execution for:
- **Ingestion pipeline**: normalize → upsert → embed → infer semantic edges
- **Agent workflows**: subagent fanout (`agent.execute-subagent`), background task execution
- **Playbook execution**: trigger matching → step execution with event hashing
- **Billing**: usage rollup, dunning sweep
- **Privacy**: GDPR export and erasure

> **Decisions:** [ADR-002 — Inngest as job orchestration](../../docs/adr/ADR-002-inngest-as-job-orchestration.md), [ADR-010 — Subagent fanout via Inngest invoke](../../docs/adr/ADR-010-subagent-fanout-via-inngest.md). Code execution runs in a vendor-neutral sandbox ([ADR-007 — Docker as code sandbox](../../docs/adr/ADR-007-docker-as-code-sandbox.md), [ADR-011 — Vercel Sandbox driver](../../docs/adr/ADR-011-vercel-sandbox-driver.md)).

## Architecture Decision Records

The decisions above are recorded in full under [`docs/adr/`](../../docs/adr/) — context, alternatives, and consequences per call. ADRs are sequentially numbered and never edited after acceptance; a changed call is captured by a new superseding ADR.

| ADR | Decision | Relevant section |
|---|---|---|
| [001](../../docs/adr/ADR-001-drizzle-as-postgres-orm.md) | Drizzle as Postgres ORM | Data Storage Boundaries |
| [002](../../docs/adr/ADR-002-inngest-as-job-orchestration.md) | Inngest as job orchestration | Background Job Architecture |
| [003](../../docs/adr/ADR-003-neo4j-as-vector-store.md) | Neo4j as vector store | Data Storage Boundaries |
| [004](../../docs/adr/ADR-004-env-vars-not-secret-manager.md) | Env vars, not Secret Manager | (dependencies / config) |
| [005](../../docs/adr/ADR-005-single-version-monorepo.md) | Single-version monorepo | (repo layout) |
| [006](../../docs/adr/ADR-006-better-auth-bound-to-canonical-users.md) | Better Auth bound to `auth.users` | Multi-tenancy |
| [007](../../docs/adr/ADR-007-docker-as-code-sandbox.md) | Docker as code sandbox | Background Job Architecture |
| [008](../../docs/adr/ADR-008-skills-filesystem-first.md) | Skills filesystem-first | Agent Runtime |
| [009](../../docs/adr/ADR-009-unified-capability-tool-model.md) | Unified capability/tool model via `surfaces` | Capability Kernel |
| [010](../../docs/adr/ADR-010-subagent-fanout-via-inngest.md) | Subagent fanout via Inngest | Background Job Architecture |
| [011](../../docs/adr/ADR-011-vercel-sandbox-driver.md) | Vercel Sandbox driver | Background Job Architecture |
| [012](../../docs/adr/ADR-012-connector-dual-write-pattern.md) | Connector dual-write (Postgres + Neo4j) | Data Storage Boundaries |
| [013](../../docs/adr/ADR-013-oxagen-plugins-capability-packs.md) | Oxagen Plugins capability packs | Capability Kernel (entitlement gate) |
| [014](../../docs/adr/ADR-014-workspace-scoped-mcp-registry-single-default.md) | Workspace-scoped MCP registries | Surface Architecture / Multi-tenancy |
