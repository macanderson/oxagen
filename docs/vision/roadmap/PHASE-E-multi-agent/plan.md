# Phase E: Multi-Agent Blackboard

> Replace ad-hoc subagent spawning with a coordinated, shared memory bus where agents
> discover and share knowledge without duplicating work.

---

## Overview

Phase E builds the multi-agent coordination layer — a blackboard-style shared memory bus where multiple agents working on the same project can share discoveries, avoid duplicate work, and build on each other's findings. This replaces the partially-built research swarm with a principled architecture backed by the Engram memory substrate.

After this phase, spawning three agents on a refactoring task means they coordinate: one discovers the dependency chain, writes it to the blackboard, and the others immediately see it without re-running grep. An intent ledger prevents two agents from fixing the same bug simultaneously.

---

## Prerequisites

- **Phase B complete**: Context compiler working — agents can `compile()` from shared memory
- **Phase D complete**: Salience scoring and consolidation — shared memories have quality rankings
- Namespace model established (Phase A) with org/workspace/session/agent hierarchy
- `packages/tenancy` RLS patterns understood and applicable to memory boundary
- Existing subagent dispatch (`packages/agent/src/dispatch/subagent.ts`) operational

---

## Parallel Tracks

### Track 1: Blackboard Protocol (Agent 1)

**Goal**: Build the shared, scoped memory bus that agents read from and write to.

**Deliverables**:
- `packages/engram/src/blackboard/bus.ts` — Memory bus implementation
- `packages/engram/src/blackboard/subscriber.ts` — Pub/sub for memory events
- `packages/engram/src/blackboard/types.ts` — Blackboard protocol types
- `packages/engram/src/blackboard/discovery.ts` — Discovery broadcast

**Architecture**:

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Agent A    │    │   Agent B    │    │   Agent C    │
│  (private)   │    │  (private)   │    │  (private)   │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │
       │ write/read        │ write/read        │ write/read
       │                   │                   │
┌──────▼───────────────────▼───────────────────▼───────┐
│                BLACKBOARD (shared layer)               │
│                                                       │
│  ┌─────────┐  ┌─────────────┐  ┌──────────────────┐ │
│  │Episodic │  │  Semantic   │  │  Entity/Graph    │ │
│  │(shared) │  │  (shared)   │  │  (shared)        │ │
│  └─────────┘  └─────────────┘  └──────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  Intent Ledger | Subscriptions | Leases         │ │
│  └─────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

**Implementation**:

```typescript
// packages/engram/src/blackboard/types.ts

export interface BlackboardConfig {
  namespace: Namespace;          // Shared namespace (workspace-level)
  agents: AgentRegistration[];   // Registered participants
  maxRetention: number;          // Max records before eviction
}

export interface AgentRegistration {
  agentId: string;
  role: string;                  // What this agent does
  capabilities: string[];        // What tools/capabilities it has
  registeredAt: number;
}

export interface BlackboardEvent {
  type: "discovery" | "assertion" | "question" | "coordination";
  agentId: string;
  recordId: string;              // The Engram record this event refers to
  visibility: "broadcast" | "targeted";
  targets?: string[];            // If targeted, which agent IDs
  priority: "low" | "normal" | "high" | "urgent";
}

export interface Subscription {
  agentId: string;
  pattern: SubscriptionPattern;
  callback: (event: BlackboardEvent) => Promise<void>;
}

export interface SubscriptionPattern {
  kinds?: RecordKind[];          // Filter by record kind
  domains?: string[];            // Filter by semantic domain
  entityTypes?: string[];        // Filter by entity type
  minSalience?: number;         // Minimum salience threshold
}
```

**Memory bus**:

```typescript
// packages/engram/src/blackboard/bus.ts

export class BlackboardBus {
  private subscriptions: Map<string, Subscription[]> = new Map();
  private engram: Engram;
  private namespace: Namespace;

  constructor(config: BlackboardConfig) {
    this.namespace = config.namespace;
    this.engram = createEngram({ namespace: config.namespace });
  }

  /**
   * Write a discovery to the shared blackboard.
   * All subscribed agents are notified.
   */
  async publish(agentId: string, record: MemoryRecord, priority: BlackboardEvent["priority"] = "normal"): Promise<void> {
    // 1. Write to shared namespace
    const id = await this.engram.remember(record.body as EpisodicBody, {
      namespace: this.namespace,
      salience: record.salience,
      provenance: { ...record.provenance, author: agentId },
    });

    // 2. Notify subscribers
    const event: BlackboardEvent = {
      type: "discovery",
      agentId,
      recordId: id,
      visibility: "broadcast",
      priority,
    };
    await this.notifySubscribers(event);
  }

  /**
   * Subscribe to blackboard events matching a pattern.
   */
  subscribe(agentId: string, pattern: SubscriptionPattern, callback: Subscription["callback"]): void {
    const existing = this.subscriptions.get(agentId) ?? [];
    existing.push({ agentId, pattern, callback });
    this.subscriptions.set(agentId, existing);
  }

  /**
   * Query the shared blackboard (delegates to compile() with shared namespace).
   */
  async query(agentId: string, taskFrame: TaskFrame, budget: TokenBudget): Promise<ContextWindow> {
    // Agent gets: its private records + shared blackboard records
    const mergedFrame = { ...taskFrame, additionalNamespaces: [this.namespace] };
    return compile(mergedFrame, budget);
  }

  private async notifySubscribers(event: BlackboardEvent): Promise<void> {
    for (const [, subs] of this.subscriptions) {
      for (const sub of subs) {
        if (matchesPattern(event, sub.pattern)) {
          await sub.callback(event);
        }
      }
    }
  }
}
```

**Tests**:
- Agent A publishes discovery → Agent B receives notification
- Subscriptions filter by pattern (only matching events delivered)
- Shared records are visible to all agents in the workspace
- Private records are NOT visible to other agents
- Priority ordering: urgent events delivered before normal

**Estimated effort**: 7–8 days

---

### Track 2: Namespace Enforcement (Agent 2)

**Goal**: Enforce hierarchical namespace scoping with RLS at the Engram boundary. Every read/write is verified against the agent's permissions.

**Deliverables**:
- `packages/engram/src/blackboard/namespace.ts` — Namespace enforcement layer
- `packages/engram/src/blackboard/access-control.ts` — Permission model
- `packages/engram/src/blackboard/isolation.ts` — Memory isolation guarantees

**Namespace hierarchy**:

```
org: "acme"
├── workspace: "platform"
│   ├── session: "sess-123"
│   │   ├── agent: "agent-a" (private)
│   │   ├── agent: "agent-b" (private)
│   │   └── shared (blackboard)
│   ├── session: "sess-456"
│   │   └── ...
│   └── workspace-shared (persistent across sessions)
└── workspace: "marketing"
    └── ... (completely isolated from "platform")
```

**Access control**:

```typescript
// packages/engram/src/blackboard/access-control.ts

export interface AgentPermissions {
  agentId: string;
  read: NamespaceGrant[];
  write: NamespaceGrant[];
}

export interface NamespaceGrant {
  namespace: Namespace;
  scope: "own" | "session" | "workspace";
  kinds?: RecordKind[];      // Restrict to specific record kinds
}

/**
 * Default permissions for an agent:
 * - Read/write its own private namespace
 * - Read/write the session's shared blackboard
 * - Read (only) the workspace-level persistent memory
 */
export function defaultAgentPermissions(agentId: string, session: string, workspace: string, org: string): AgentPermissions {
  return {
    agentId,
    read: [
      { namespace: { org, workspace, session, agent: agentId }, scope: "own" },
      { namespace: { org, workspace, session }, scope: "session" },
      { namespace: { org, workspace }, scope: "workspace" },
    ],
    write: [
      { namespace: { org, workspace, session, agent: agentId }, scope: "own" },
      { namespace: { org, workspace, session }, scope: "session" },
    ],
  };
}

/**
 * Enforce access control on every Engram operation.
 * Throws NamespaceAccessError if the agent doesn't have permission.
 */
export function enforceAccess(
  agentId: string,
  operation: "read" | "write",
  targetNamespace: Namespace,
  permissions: AgentPermissions,
): void {
  const grants = operation === "read" ? permissions.read : permissions.write;
  const allowed = grants.some((g) => namespaceContains(g.namespace, targetNamespace));
  if (!allowed) {
    throw new NamespaceAccessError(agentId, operation, targetNamespace);
  }
}
```

**Integration with `packages/tenancy`**:
- Workspace-level isolation maps directly to `runInTenantScope({ orgId, workspaceId })`
- Session-level isolation is enforced by Engram (not Postgres RLS)
- Agent-level isolation is enforced by Engram's access control layer
- Cross-org access is never allowed (hard boundary at org level)

**Tests**:
- Agent cannot read another agent's private namespace
- Agent can read shared session namespace
- Agent cannot write to workspace-level namespace (read-only for agents)
- Cross-workspace access blocked
- Cross-org access blocked (even with explicit grant attempt)
- Permissions are enforced at the engine boundary (not application layer)

**Estimated effort**: 5–6 days

---

### Track 3: Agent Coordination (Agent 3)

**Goal**: Build the intent ledger and coordination primitives that prevent duplicate work and enable cooperative task decomposition.

**Deliverables**:
- `packages/engram/src/blackboard/intent.ts` — Intent ledger (claim work items)
- `packages/engram/src/blackboard/lease.ts` — Resource leases (exclusive access)
- `packages/engram/src/blackboard/coordinator.ts` — High-level coordination API

**Intent ledger**:

```typescript
// packages/engram/src/blackboard/intent.ts

export interface Intent {
  id: string;
  agentId: string;
  action: string;            // What the agent plans to do
  targets: string[];         // File paths, entity IDs, etc.
  status: "claimed" | "in_progress" | "completed" | "abandoned";
  claimedAt: number;
  expiresAt: number;         // Auto-abandon if not completed
  result?: unknown;          // Outcome once completed
}

export class IntentLedger {
  private intents: Map<string, Intent> = new Map();

  /**
   * Claim an intent. Returns false if another agent already claimed
   * the same targets for the same action.
   */
  async claim(agentId: string, action: string, targets: string[], ttl: number = 300_000): Promise<{ success: boolean; conflictingIntent?: Intent }> {
    // Check for conflicts
    const conflict = this.findConflict(action, targets);
    if (conflict && conflict.agentId !== agentId) {
      return { success: false, conflictingIntent: conflict };
    }

    const intent: Intent = {
      id: `intent-${Date.now()}-${agentId}`,
      agentId,
      action,
      targets,
      status: "claimed",
      claimedAt: Date.now(),
      expiresAt: Date.now() + ttl,
    };

    this.intents.set(intent.id, intent);
    return { success: true };
  }

  /**
   * Complete an intent (mark as done, share result).
   */
  async complete(intentId: string, result?: unknown): Promise<void> {
    const intent = this.intents.get(intentId);
    if (!intent) throw new Error("Intent not found");
    intent.status = "completed";
    intent.result = result;
  }

  /**
   * Check if targets are already claimed by another agent.
   */
  private findConflict(action: string, targets: string[]): Intent | undefined {
    const now = Date.now();
    for (const intent of this.intents.values()) {
      if (intent.status === "completed" || intent.status === "abandoned") continue;
      if (intent.expiresAt < now) { intent.status = "abandoned"; continue; }
      if (intent.action === action && hasOverlap(intent.targets, targets)) {
        return intent;
      }
    }
    return undefined;
  }
}
```

**Resource leases**:

```typescript
// packages/engram/src/blackboard/lease.ts

export interface Lease {
  id: string;
  agentId: string;
  resource: string;          // What's being exclusively held
  grantedAt: number;
  expiresAt: number;
  renewable: boolean;
}

/**
 * Exclusive resource leases for genuinely exclusive operations:
 * - A git worktree (only one agent can modify at a time)
 * - A database migration (sequential execution)
 * - A deployment slot
 */
export class LeaseManager {
  async acquire(agentId: string, resource: string, ttl: number): Promise<Lease | null> {
    const existing = this.activeLease(resource);
    if (existing && existing.agentId !== agentId) return null;
    // Grant lease...
  }

  async release(leaseId: string): Promise<void> { /* ... */ }
  async renew(leaseId: string, additionalTtl: number): Promise<boolean> { /* ... */ }
}
```

**High-level coordinator**:

```typescript
// packages/engram/src/blackboard/coordinator.ts

export class AgentCoordinator {
  private bus: BlackboardBus;
  private intents: IntentLedger;
  private leases: LeaseManager;

  /**
   * Before starting work, check if another agent is already handling it.
   * If so, wait for their result instead of duplicating effort.
   */
  async beforeWork(agentId: string, action: string, targets: string[]): Promise<"proceed" | "wait" | "skip"> {
    const claim = await this.intents.claim(agentId, action, targets);
    if (claim.success) return "proceed";

    // Another agent is working on this — check if we should wait or skip
    if (claim.conflictingIntent!.status === "in_progress") return "wait";
    return "skip";
  }

  /**
   * After completing work, share the result with all agents.
   */
  async afterWork(agentId: string, intentId: string, result: unknown): Promise<void> {
    await this.intents.complete(intentId, result);
    // Publish result to blackboard
    await this.bus.publish(agentId, {
      kind: "semantic",
      body: { fact: JSON.stringify(result), domain: "agent-discovery" },
      salience: 0.8,
      // ... other record fields
    } as MemoryRecord, "high");
  }
}
```

**Tests**:
- Two agents claiming same targets: first wins, second gets conflict
- Intent expires after TTL → targets become available
- Lease prevents concurrent access to exclusive resources
- Coordinator: agent waits when another is working on same targets
- Coordinator: agent skips when work is already completed

**Estimated effort**: 6–7 days

---

### Track 4: Lineage Tracking (Agent 4)

**Goal**: Full causal chain from source to derived knowledge. Which agent learned what, from which inputs, with what confidence.

**Deliverables**:
- `packages/engram/src/blackboard/lineage.ts` — Lineage graph construction
- `packages/engram/src/blackboard/provenance-query.ts` — "Why does the agent believe X?"
- `packages/engram/src/blackboard/trust.ts` — Trust scoring based on lineage

**Lineage graph**:

```typescript
// packages/engram/src/blackboard/lineage.ts

export interface LineageNode {
  recordId: string;
  agentId: string;
  kind: RecordKind;
  createdAt: number;
  confidence: number;
}

export interface LineageEdge {
  from: string;              // Source record ID
  to: string;               // Derived record ID
  relationship: "derived_from" | "contradicts" | "supports" | "supersedes";
  agentId: string;           // Agent that created this derivation
}

/**
 * Build the lineage graph for a record — trace back to the original
 * episodic events that led to this knowledge.
 */
export async function traceLineage(
  recordId: string,
  store: EngramStore,
  maxDepth: number = 10,
): Promise<{ nodes: LineageNode[]; edges: LineageEdge[] }> {
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];
  const visited = new Set<string>();
  const queue = [recordId];

  while (queue.length > 0 && nodes.length < maxDepth * 10) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const record = await store.getById(id);
    if (!record) continue;

    nodes.push({
      recordId: id,
      agentId: record.provenance.author,
      kind: record.kind,
      createdAt: record.createdAt,
      confidence: record.confidence,
    });

    // Follow derivation chain
    for (const parentId of record.provenance.derivedFrom) {
      edges.push({ from: parentId, to: id, relationship: "derived_from", agentId: record.provenance.author });
      queue.push(parentId);
    }

    // Follow causality chain
    for (const parentId of record.causality) {
      if (!edges.some((e) => e.from === parentId && e.to === id)) {
        edges.push({ from: parentId, to: id, relationship: "derived_from", agentId: record.provenance.author });
        queue.push(parentId);
      }
    }
  }

  return { nodes, edges };
}
```

**Provenance queries** ("why does the agent believe X?"):

```typescript
// packages/engram/src/blackboard/provenance-query.ts

export interface ProvenanceExplanation {
  belief: MemoryRecord;                    // The fact in question
  evidence: MemoryRecord[];                 // Supporting episodic events
  derivationChain: LineageEdge[];          // How it was derived
  agents: { agentId: string; role: string }[];  // Which agents contributed
  confidence: number;                       // Overall confidence
  conflicts?: MemoryRecord[];              // Contradicting facts, if any
}

/**
 * Explain why a particular fact exists in memory.
 * Used for debugging multi-agent runs and for trust decisions.
 */
export async function explainBelief(
  factId: string,
  store: EngramStore,
): Promise<ProvenanceExplanation> {
  const fact = await store.getById(factId);
  if (!fact) throw new Error("Fact not found");

  const lineage = await traceLineage(factId, store);
  const evidence = lineage.nodes
    .filter((n) => n.kind === "episodic")
    .map((n) => store.getById(n.recordId));

  // ... build explanation
}
```

**Trust scoring**:
- Records with longer, verifiable derivation chains are more trustworthy
- Records derived from multiple independent agents are more trustworthy
- Records that contradict higher-confidence facts are flagged for review
- Trust score factors into retrieval ranking (Phase D's salience)

**Tests**:
- Lineage traces back from semantic fact to original episodic events
- Multi-agent derivation: fact contributed to by 3 agents has full chain
- Provenance query returns human-readable explanation
- Trust scoring: independently-derived facts score higher
- Conflict: contradicting facts both appear in lineage with annotations

**Estimated effort**: 5–6 days

---

## Deliverables Checklist

- [ ] Blackboard memory bus with pub/sub
- [ ] Discovery broadcast (agent writes, all see)
- [ ] Namespace-scoped read/write with RLS enforcement
- [ ] Private + shared memory layers per agent
- [ ] Intent ledger (claim targets, prevent duplicates)
- [ ] Resource leases (exclusive access for mutations)
- [ ] Agent coordinator (before/after work hooks)
- [ ] Lineage graph construction
- [ ] Provenance query ("why does the agent believe X?")
- [ ] Trust scoring based on derivation chain
- [ ] Research swarm migrated to blackboard

---

## Success Criteria

| Metric | Target |
|---|---|
| Duplicate work prevention | > 90% of duplicate searches eliminated |
| Discovery propagation | Shared within 1 turn of publication |
| Namespace isolation | Zero cross-tenant leakage (security test) |
| Intent conflict resolution | < 5% of claims result in deadlock |
| Lineage completeness | 100% of semantic facts traceable to episodic source |
| Provenance query response | < 100ms for 5-level deep lineage |

---

## Dependencies on Other Phases

| Depends On | Details |
|---|---|
| Phase B | Context compiler must support multi-namespace retrieval |
| Phase D | Salience scoring needed for ranking shared discoveries |
| Phase A | Namespace model and record format |

| Depended On By | Details |
|---|---|
| Phase F | CRDT sync needed for offline multi-agent coordination |
| Phase F | Eval harness measures multi-agent coordination efficiency |

---

## Migration: Research Swarm → Blackboard

The existing research swarm (`packages/agent/src/dispatch/subagent.ts`) migrates to the blackboard model:

| Current Behavior | Blackboard Replacement |
|---|---|
| Subagent spawned via Inngest invoke | Agent registered on blackboard |
| Results passed back via function return | Results written to shared namespace |
| No dedup — agents may search same things | Intent ledger prevents duplicate work |
| No shared context — each agent rebuilds | Shared blackboard provides common ground |
| Ad-hoc coordination via parent orchestration | Coordinator manages work distribution |

**Migration steps**:
1. Register blackboard for the research session namespace
2. Each research agent subscribes to discoveries in their domain
3. Before executing a search, check intent ledger for conflicts
4. After finding results, publish to blackboard (not return to parent)
5. Parent agent reads all discoveries from blackboard at end
6. Remove direct return-value passing pattern

---

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Pub/sub latency too high for real-time coordination | Low | In-process bus (same daemon); pub/sub is notification only |
| Intent ledger creates deadlocks | Medium | TTL-based expiry; abandoned intents auto-release |
| Namespace enforcement too restrictive | Low | Start permissive (session-level sharing); tighten later |
| Lineage graphs grow unbounded | Medium | Limit depth; prune old episodic sources after consolidation |
| Multi-agent conflicts overwhelm resolver | Low | Rate-limit conflict creation; batch resolution in consolidation |

---

## Files Created / Modified

### Created
| File | Purpose |
|---|---|
| `packages/engram/src/blackboard/bus.ts` | Memory bus |
| `packages/engram/src/blackboard/subscriber.ts` | Pub/sub |
| `packages/engram/src/blackboard/types.ts` | Protocol types |
| `packages/engram/src/blackboard/discovery.ts` | Discovery broadcast |
| `packages/engram/src/blackboard/namespace.ts` | Namespace enforcement |
| `packages/engram/src/blackboard/access-control.ts` | Permission model |
| `packages/engram/src/blackboard/isolation.ts` | Isolation guarantees |
| `packages/engram/src/blackboard/intent.ts` | Intent ledger |
| `packages/engram/src/blackboard/lease.ts` | Resource leases |
| `packages/engram/src/blackboard/coordinator.ts` | Coordination API |
| `packages/engram/src/blackboard/lineage.ts` | Lineage graph |
| `packages/engram/src/blackboard/provenance-query.ts` | Provenance queries |
| `packages/engram/src/blackboard/trust.ts` | Trust scoring |

### Modified
| File | Change |
|---|---|
| `packages/agent/src/dispatch/subagent.ts` | Use blackboard for shared state |
| `packages/engram/src/compiler/compile.ts` | Support multi-namespace retrieval |
| `packages/engram/src/index.ts` | Export blackboard module |
| `packages/inngest-functions/src/functions/agent.execute-subagent.ts` | Register on blackboard |
