# Graph-mediated file locking for agent fleets

**Status:** superseded by ADR-021 and the workspace-graph boundary · **Owner:** platform · **Branch:** `claude/ai-agent-file-locking-ltzzc3`

> This document is historical. Neo4j file locks and lock projections are not a
> launch surface. Transactional Postgres leases are the sole authority; future
> exact file lineage belongs in the immutable run-evidence ledger.

Let a fleet of coding agents work one tree at once **without a single
coordinator process**: before an agent edits a file it claims a lock, and the
lock lives in the graph so every agent in every process sees it. Locks are
lease-bound (auto-expire if an agent crashes) and released the moment work
finishes.

This deepens the wedge: fleet lineage + graph-grounded coordination. The
coordination substrate is the same graph that grounds answers, so "who is
touching what, and why" is one traversal.

---

## 1. What already exists (recovered, not net-new)

A multi-agent coordination module was **built and left unwired** in
`packages/engram/src/blackboard/`. The bloat sweep (PR #564, commit `a346dcf`)
deleted its `index.ts` barrel; the implementation files survived but are
consumed by nothing. This branch restored the barrel.

| File | Primitive | Fit for file locking |
| --- | --- | --- |
| `intent.ts` — `IntentLedger` | `claim(agentId, action, targets[], ttl)` with target-overlap conflict detection + TTL auto-expiry | **This is the file lock.** `targets` are file paths. |
| `lease.ts` — `LeaseManager` | exclusive lease on a named resource (`git:worktree`, `deploy:prod`) with renew/release | Non-file exclusivity (worktree, migration slot). |
| `coordinator.ts` — `AgentCoordinator` | `beforeWork` → `proceed`/`wait`/`skip`; `afterWork`; `acquireLease`/`releaseLease` | The high-level API agents call. |
| `bus.ts`, `access-control.ts`, `lineage.ts` | shared blackboard bus, namespace ACL, provenance tracing | Supporting; out of scope for v1. |

**Why it never worked as a fleet primitive:** every store is a process-local
`Map` (`private intents = new Map()`, `private leases = new Map()`). Two agents
in two processes (the real fleet topology) never see each other's claims. The
shape is right; the **backing store is wrong.** This spec swaps the store for
the graph and keeps the API.

Related prior art: PR #551 (graph-mediated fanout Phase 2) shipped
claim/lease over **task rows** in Postgres (`agent.subagent_runs.claimed_by /
lease_expires_at`, `FOR UPDATE SKIP LOCKED`) plus an `agent.lease-sweep` cron.
That is row-level task coordination; this is **path-level file** coordination.
The lease-sweep pattern is reused (§5).

---

## 2. Store decision — Neo4j is the authoritative lock

Per the request, **the graph holds the lock.** The mutex is a `:FileLock`
node with a node-key uniqueness constraint on `(orgId, workspaceId, key)`.
Neo4j takes a write lock on the index entry for the duration of a `MERGE`
transaction, so concurrent `MERGE`s on the same key **serialize** — the
database is the coordinator, which is precisely the "no single coordinator"
requirement.

> **Boundary note (must be justified in the PR).** `oxagen-engineering-policy`
> and CLAUDE.md declare Neo4j "graph data only" and transactional state
> "Postgres only." A lease-bound lock is ephemeral transactional state, so this
> is a deliberate, documented exception: the value is co-locating the lock with
> fleet lineage/memory so coordination is graph-grounded and queryable. Two
> alternatives were considered and are viable fallbacks if graph contention or
> AuraDB latency bite:
>
> - **Hybrid** — Postgres is the authoritative mutex; active locks are
>   *projected* to Neo4j `:FileLock` nodes for visibility (mirrors how #551
>   projects terminal fanout children as `:Execution`). Boundary-correct + still
>   graph-grounded.
> - **Postgres-only** — an `agent.file_locks` table extending #551's
>   claim/lease + lease-sweep. Simplest, boundary-correct, not "in the graph."
>
> The design below is **store-swappable**: the lock lives behind a
> `LockStore` port, so moving the authority to Postgres later is a one-adapter
> change, not a rewrite of the engine wiring.

---

## 3. Graph model

New fixed system label `NodeLabels.FileLock` + schema (`packages/ontology/src/schema.cypher`):

```cypher
CREATE CONSTRAINT file_lock_key IF NOT EXISTS
  FOR (n:FileLock) REQUIRE (n.orgId, n.workspaceId, n.key) IS NODE KEY;
CREATE INDEX file_lock_expiry IF NOT EXISTS FOR (n:FileLock) ON (n.expiresAt);
CREATE INDEX file_lock_holder IF NOT EXISTS FOR (n:FileLock) ON (n.orgId, n.holderRunId);
```

`:FileLock` properties: `key` (normalized `workspace-relative` path, or
`resource:<name>` for non-file leases), `orgId`, `workspaceId`, `holderAgentId`,
`holderRunId`, `fanoutId` (fleet group), `action` (`edit`/`refactor`/…),
`acquiredAt`, `expiresAt`, `renewCount`. Optional `[:HOLDS]` edge from the
holder `:Execution`/`:Agent` node so lineage ("what is run X locking?") is a
one-hop traversal.

---

## 4. Atomic acquire / renew / release (Cypher)

**Acquire (single statement; steals an expired lock, idempotent for the holder):**

```cypher
MERGE (l:FileLock {orgId:$org, workspaceId:$ws, key:$key})
  ON CREATE SET l.holderRunId=$run, l.holderAgentId=$agent, l.action=$action,
                l.fanoutId=$fanout, l.acquiredAt=$now, l.expiresAt=$exp, l.renewCount=0
WITH l, (l.holderRunId=$run OR l.expiresAt < $now) AS mine
SET l += CASE WHEN mine THEN {holderRunId:$run, holderAgentId:$agent, action:$action,
              fanoutId:$fanout, acquiredAt:$now, expiresAt:$exp} ELSE {} END
RETURN (l.holderRunId=$run) AS acquired, l.holderRunId AS heldBy, l.expiresAt AS expiresAt
```

**Multi-file, deadlock-free:** sort keys canonically and acquire in one
transaction via `UNWIND $keys AS key …`; if any row returns `acquired=false`,
roll the transaction back so no partial claim is held. Canonical ordering makes
classic AB/BA deadlock impossible.

**Renew (heartbeat):** `MATCH … WHERE l.holderRunId=$run SET l.expiresAt=$exp, l.renewCount=l.renewCount+1`.

**Release:** `MATCH … WHERE l.holderRunId=$run DELETE l` — idempotent; a
non-holder release is a no-op.

---

## 5. Capability parity (contract → API → MCP → CLI → docs)

Per the capability-parity law, locking is a governed capability, not raw Cypher:

- Contracts in `packages/oxagen/src/contracts/`:
  `agent.lock.acquire`, `agent.lock.release`, `agent.lock.renew`, `agent.lock.list`.
- Handlers in `packages/handlers/` calling the ontology mutation layer
  (`packages/ontology/src/mutations/file-lock.ts`), tenant-scoped via `invoke()`.
- API routes `apps/api/src/routes/v1/agent-lock.ts`; MCP tools
  `apps/mcp/src/tools/agent-lock.ts`; CLI `apps/cli/src/commands/lock.tsx`;
  docs `docs/capabilities/agent.lock.*.md` + `_index.md`.
- `agent.lease-sweep` cron gains a FileLock pass: delete/telemeter locks past
  `expiresAt`, emit `agent.lock.expired` / `agent.lock.reclaimed` to ClickHouse.

---

## 6. Wiring into the agent engine (the point of it all)

Two seams, both already located:

1. **Per-edit claim — `packages/agent-engine/src/tools.ts` `buildWorkspaceTools`.**
   Add a `LockPort` (new engine port in `ports.ts`, injected like `MemoryProvider`).
   Before `workspace.writeFile`/edit, `await lock.acquire(path)`; on conflict the
   tool returns a soft failure the model can act on ("held by run X until T —
   wait or pick another file") instead of corrupting the tree. Claims are held
   for the run and released on run teardown; a heartbeat timer renews the lease
   around long edits (reuse the Phase 2 lease-renew timer pattern).

2. **Fleet-level replacement — `packages/agent-engine/src/fleet/index.ts:193-221`.**
   Today the orchestrator gates tasks on an **in-process** `lockedFiles` Set
   built from *predicted* files. Replace that with `LockPort` claims so
   coordination is (a) cross-process and (b) dynamic (real files touched, not a
   guessed manifest). The in-process Set stays as a fast-path L1 cache in front
   of the graph.

CLI injects a local `LockPort` (still graph-backed via `@oxagen/ontology` when
`NEO4J_*` present; degrades to the existing in-memory `IntentLedger` for
offline BYOK). Platform injects the metered, tenant-scoped `invoke()`-backed
adapter.

---

## 7. Phases

- **P0 — restore + port (this branch):** restored `blackboard/index.ts`; define
  the `LockStore`/`LockPort` interface; keep in-memory impl as the offline
  adapter. *(barrel restored)*
- **P1 — graph store:** `NodeLabels.FileLock`, schema.cypher constraints,
  `ontology/src/mutations/file-lock.ts` (acquire/renew/release/list), unit +
  integration tests against local Neo4j proving MERGE exclusivity, expired
  steal, holder-guarded release, org isolation.
- **P2 — capability parity:** four `agent.lock.*` contracts + handlers + API +
  MCP + CLI + docs; `pnpm check:manifest` clean.
- **P3 — engine wiring:** `LockPort` in `ports.ts`; claim/release in
  `tools.ts`; replace fleet `lockedFiles` with graph claims; heartbeat renew.
- **P4 — self-healing:** FileLock pass in `agent.lease-sweep`; `agent.lock.*`
  telemetry; `pnpm metrics:fanout`-style lock/contention report.

## 8. Acceptance

- Two agents in two processes cannot hold `edit` on the same path at once
  (integration test, real Neo4j).
- A crashed holder's lock auto-expires and is stealable after TTL.
- Release on run completion is immediate and idempotent.
- Full parity (`check:manifest`), docs present, `pnpm gate` green.
