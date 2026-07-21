# Agent File Locking — archived graph-backed plan

Status: **Superseded.** Neo4j/`HOLDS_LOCK` and the former graph-sync adapter are
not lock authority. Current launch enforcement uses transactional Postgres
leases in `agent.file_locks`, monotonic fencing tokens in
`agent.file_lock_fences`, and `createFileLeaseLockAdapter` at the shared
`write_file`/`edit_file` enforcement point. The old `GraphSyncProvider` shape
must not be restored or reused for coordination.

Any future visibility into which run held which lock belongs in the immutable
run-evidence ledger and may be projected into the workspace graph only from a
narrow, authenticated server-side path. That evidence path is not implemented
or specified by this plan. Sections 1–11 below are retained as historical design
and rollout evidence; their Neo4j authority and graph-projection claims are no
longer normative.

Owner: platform / agent-engine
Related: `docs/specs/graph-mediated-fanout-phase2/`, ADR-010 (subagent fan-out via Inngest)

## 1. Problem & goal

When a fleet of agents runs in parallel over the same repo/workspace they clobber
each other's files. We want **coordinator-free coordination**: before an agent
edits a file it acquires a lock; when it's done (or crashes) the lock is released
or auto-expires, so no two live agents ever hold the same file at once. The lock
store is the **Neo4j knowledge graph** — the same store that already records
`(:Execution)-[:TOUCHED_FILE]->(:SourceFile)` file lineage — so a held lock is a
first-class, queryable, cited graph fact and rides the existing fleet-lineage moat.

## 2. What already exists (restored, in-memory, unwired)

The building blocks live in `packages/engram/src/blackboard/` (added in PR #541 /
commit `1bb1428` as "Phase 2 graph-mediated fleet coordination (blackboard)").
The sub-barrel `blackboard/index.ts` was deleted as "redundant" in the bloat
rip-out (PR #564 / `a346dcf`); this branch restores it. The module is exported
from `packages/engram/src/index.ts` but **has zero consumers** — it was built and
never wired.

| File | Role | Store today |
|---|---|---|
| `intent.ts` — `IntentLedger.claim(agentId, action, targets[])` | **the file lock**: `targets` are file paths; `findConflict` rejects overlapping claims; TTL auto-abandon for crashed agents | in-memory `Map` |
| `lease.ts` — `LeaseManager.acquire(agentId, resource, ttlMs)` | exclusive lease on a *non-file* singleton resource (worktree, deploy slot) | in-memory `Map` |
| `coordinator.ts` — `AgentCoordinator.beforeWork/afterWork/acquireLease/releaseLease` | high-level agent API combining intent + lease + bus | delegates |
| `bus.ts`, `access-control.ts`, `lineage.ts`, `types.ts` | pub/sub, namespace ACL, provenance | engram store |

The **file-lock semantics we want are the `IntentLedger`/`beforeWork` overlap +
TTL logic** — we keep that shape but move the store from an in-process `Map` to a
tenant-scoped Neo4j edge so it survives across processes/machines. This is
distinct from the durable Postgres **claim/lease** on `agent.subagent_runs`
(`claimed_by` / `lease_expires_at`, migration `20260703150000_phase2_claim_lease`,
`FOR UPDATE SKIP LOCKED`) — that claims *work rows*, not *files*, and is not
graph-backed.

## 3. Graph lock model

Reuse the existing `:SourceFile` primitive and its natural key, do **not** invent
a new file identity.

- **Node**: `(:SourceFile { naturalKey, orgId })` — already MERGEd by
  `packages/agent/src/adapters/graph-sync.ts` (`toNaturalKey(path, owner, repo)`)
  and `packages/ontology/src/mutations/record-execution.ts`. The lock keys off the
  same `naturalKey`, so a locked file and a touched file are the same node.
- **Holder**: `(:Agent { id, orgId })` — already MERGEd on the `INVOKED` edge.
- **Lock edge** (new `EdgeType`): `(:Agent)-[:HOLDS_LOCK { lockId, acquiredAt,
  expiresAt, workspaceId, action, executionId }]->(:SourceFile)`.
  - Add `HOLDS_LOCK: "HOLDS_LOCK"` to `EdgeTypes` in `packages/ontology/src/types.ts`.
  - Tenant scope: every MERGE/MATCH is filtered by `{ orgId }` on both nodes and
    carries `workspaceId` on the edge (org+workspace scoping, per the four-store
    rules — graph relationships, not Postgres).
  - A file is "locked" iff a `HOLDS_LOCK` edge exists with `expiresAt > now`. Expiry
    is lazy (checked in the predicate) plus a sweep (see §6).

## 4. Acquire semantics (atomic, conditional)

Single Cypher statement, run via the ontology query layer (never a raw driver call):

```cypher
// Acquire: succeeds only if no LIVE lock is held by a different agent.
MERGE (f:SourceFile { naturalKey: $naturalKey, orgId: $orgId })
WITH f
OPTIONAL MATCH (other:Agent)-[l:HOLDS_LOCK]->(f)
  WHERE l.expiresAt > $now AND other.id <> $agentId
WITH f, l, other
CALL {
  WITH f, l
  WITH f WHERE l IS NULL          // no live conflicting lock
  MERGE (a:Agent { id: $agentId, orgId: $orgId })
  MERGE (a)-[h:HOLDS_LOCK]->(f)
  SET h.lockId = $lockId, h.acquiredAt = $now, h.expiresAt = $now + $ttlMs,
      h.workspaceId = $workspaceId, h.action = $action, h.executionId = $executionId
  RETURN h
}
RETURN CASE WHEN other IS NULL THEN true ELSE false END AS granted,
       other.id AS heldBy, l.expiresAt AS blockedUntil
```

- **Atomicity**: MERGE on the `HOLDS_LOCK` edge with the conflict predicate is
  evaluated inside one transaction; Neo4j takes a write lock on the `SourceFile`
  node for the duration, so two concurrent acquires serialize — exactly the
  guarantee the in-memory `Map` gave, now cross-process.
- **Re-entrant**: same `agentId` re-acquiring refreshes `expiresAt` (renew).
- **TTL / lease**: `expiresAt = now + ttlMs` (default mirrors `IntentLedger`'s
  `300_000` ms). A crashed agent's lock is ignored once `expiresAt` passes and is
  swept (§6). This is the file-level analogue of the Phase-2 `lease_expires_at`.

## 5. Release semantics

- **Explicit release** on task completion: `DELETE` the `HOLDS_LOCK` edge where
  `lockId = $lockId AND a.id = $agentId` (agent can only release its own lock).
- **Crash / expiry**: covered by TTL + the sweep — no held lock outlives its lease.
- **Batch release**: on agent turn end, delete all `HOLDS_LOCK` edges for
  `executionId`, so a turn never leaks locks.

## 6. Historical engine wiring proposal (superseded)

The `graph-sync.ts`/`GraphSyncProvider` wiring described here is retired. The
active engine port is backed by `packages/agent/src/adapters/file-lock-lease.ts`
and Postgres lease operations; Neo4j is never consulted to decide whether a
write may proceed.

- **Coding-agent turn** (`packages/agent/src/adapters/graph-sync.ts`): today
  `recordLineage()` writes `TOUCHED_FILE` edges after a turn. Add a symmetric
  `acquireFileLocks(files)` at the *start* of a write-phase and
  `releaseFileLocks(executionId)` in the turn's `finally`. Same `naturalKey`, same
  transaction style, same fail-soft logging.
- **Subagent fan-out** (`packages/inngest-functions/src/functions/agent.execute-subagent.ts`):
  each child acquires locks for its target files before editing and releases in its
  `finally` (there are already `catch`/`finally` blocks at lines ~348–352). A child
  that can't acquire returns a `wait`/`skip` decision instead of clobbering — this
  is `AgentCoordinator.beforeWork` re-pointed at the graph store.
- **Lease sweep**: extend the existing lease-sweep concept from Phase 2 (Postgres
  `lease_expires_at`) with a periodic Cypher `MATCH ()-[l:HOLDS_LOCK]->() WHERE
  l.expiresAt < $now DELETE l` run from the same Inngest cron that sweeps stale
  claims, so dead-agent locks are reaped even if no one tries to re-acquire.

## 7. Capability parity (contract → API → MCP → CLI)

Per CLAUDE.md, the lock ops are real capabilities invoked via `invoke()` so
metering / IAM / lineage flow — never a raw Neo4j call from a route.

| Layer | File |
|---|---|
| Contract | `packages/oxagen/src/contracts/agent.file.lock.acquire.ts` (`agent.file.lock.acquire`) |
| Contract | `packages/oxagen/src/contracts/agent.file.lock.release.ts` (`agent.file.lock.release`) |
| Contract | `packages/oxagen/src/contracts/agent.file.lock.list.ts` (introspection: who holds what) |
| Handler | `packages/agent/src/handlers/agent.file.lock.*.ts` (runs the Cypher via the ontology query layer) |
| API route | `apps/api/src/routes/v1/agent.file.lock.acquire.ts` + `.release.ts` + `.list.ts` |
| MCP tool | `apps/mcp/src/tools/agent.file.lock.acquire.ts` + `.release.ts` + `.list.ts` |
| CLI | `apps/cli/src/commands/` file-lock command (parity) |
| Docs | `docs/capabilities/agent.file.lock.acquire.md` (+ release/list), update `_index.md` |

Contract shape mirrors `agent.subagent.fanout.get.ts`: `domain: "agent"`,
`scoped: true`, `surfaces: ["api","mcp","agent"]`, acquire is `mode: "sync"`,
`riskLevel` low/medium, `defaultEffect: "deny"` with Owner/Admin + workspace
Member allow. Input `{ path, action?, ttlMs? }`; output `{ granted, lockId?,
heldBy?, blockedUntil? }`.

## 8. Tenant scoping, metering, vision

- **Scoping**: org + workspace carried on every node MERGE (`orgId`) and the edge
  (`workspaceId`); cross-org locks are structurally impossible (matches the
  blackboard `access-control.ts` "cross-org NEVER" rule).
- **Metering**: acquire/release flow through `invoke()`, so lock churn is metered
  and billable per the ClickHouse→Stripe loop — fleet coordination becomes an
  observable, priced primitive.
- **Vision**: coordinator-free fleets deepen the **fleet-lineage moat** — a held
  lock is a cited graph fact ("agent A is editing `auth.ts`, lease until T"),
  queryable alongside `TOUCHED_FILE` lineage. This advances graph-grounding +
  metering, squarely on the wedge.

## 9. Historical task list (superseded)

1. `packages/ontology/src/types.ts` — add `HOLDS_LOCK` to `EdgeTypes` (+ test).
2. `packages/ontology/src/mutations/` — add `acquire-file-lock.ts` /
   `release-file-lock.ts` / `sweep-file-locks.ts` Cypher mutations (unit tests
   against a Neo4j test container / mock, mirroring `record-execution` tests).
3. `packages/oxagen/src/contracts/agent.file.lock.{acquire,release,list}.ts` +
   contract tests.
4. `packages/agent/src/handlers/agent.file.lock.*.ts` — handlers calling the
   mutations via the ontology query layer; register in `@oxagen/handlers`.
5. `apps/api/src/routes/v1/agent.file.lock.*.ts` + `apps/mcp/src/tools/agent.file.lock.*.ts`
   + CLI command; verify with `pnpm check:manifest`.
6. `packages/agent/src/adapters/graph-sync.ts` — `acquireFileLocks` /
   `releaseFileLocks`; call from the coding-agent turn (acquire pre-write, release
   in `finally`).
7. `packages/inngest-functions/src/functions/agent.execute-subagent.ts` — acquire
   per child before edit, release in `finally`; on conflict return `wait`/`skip`.
8. Lease sweep — add the `HOLDS_LOCK` expiry DELETE to the existing stale-claim
   Inngest cron.
9. `docs/capabilities/agent.file.lock.*.md` + `_index.md`.
10. Tests: unit for each mutation/handler/contract; an integration test proving two
    concurrent acquires on one file → exactly one `granted:true`; an e2e in
    `apps/app/e2e/` if a user-facing lock view is added.

## 10. Historical blockers / open questions

- Needs a `HOLDS_LOCK` `EdgeType` and three new mutations — net-new graph surface,
  but reuses `:SourceFile` + `naturalKey` so no new node identity.
- ~~The restored `IntentLedger`/`LeaseManager`/`AgentCoordinator` stay in-memory for
  single-process use; the graph handlers are the durable, cross-process path. Decide
  whether the coordinator delegates to the graph handlers or is retired in favor of
  the contracts (recommend: coordinator becomes a thin client of the contracts).~~
  **Resolved in OXA-2075:** the blackboard module was retired (deleted) rather
  than made a thin client — see §11(b).
- Requires a running Neo4j in the agent-execution runtime (already present for
  lineage), plus `bootstrapEntitlementRuntime()` at any new worker entrypoint.

## 11. OXA-2070 historical snapshot

> The section below records what shipped at that time. It does not describe the
> current launch authority: the Postgres lease and fencing-token path supersedes
> the Neo4j lock implementation, and a future evidence ledger—not a graph sync
> provider—is the only intended lineage bridge.

**(a) Neo4j-backed acquire/release/sweep — done.**
`packages/ontology/src/mutations/{acquire-file-lock,release-file-lock,
sweep-file-locks,list-file-locks}.ts` implement §4-§6 exactly, with two
adaptations from this doc's literal Cypher, both discovered and verified
against a real local Neo4j 5.24-community instance:

1. **A composite uniqueness constraint was required.** Neo4j only takes the
   MERGE-time lock that serializes two concurrent transactions racing to
   create/match the SAME node when a uniqueness constraint backs the merged
   properties. Without one, two concurrent `acquireFileLock()` calls for the
   SAME file both passed their MERGE + conflict-check read before either
   committed, and BOTH were granted — reproduced directly against the
   integration test before the fix. Added
   `source_file_natural_key_org_unique` (composite, `naturalKey`+`orgId`) to
   `schema.cypher` — Neo4j Community DOES support composite/multi-property
   uniqueness constraints (verified directly against the container; this is
   not an Enterprise-only feature as one might assume). Applied automatically
   by the existing `pnpm db:migrate` → `migrateNeo4j()` flow.
2. **`CALL { ... }` → `OPTIONAL CALL { ... }`.** A bare `CALL` subquery
   behaves like an inner join: when its inner `WITH f WHERE l IS NULL` filters
   to zero rows (the conflict case), Neo4j silently drops the ENTIRE outer
   row, so a denied acquire came back as an empty result set instead of
   `granted:false` + `heldBy` + `blockedUntil`. `OPTIONAL CALL` (Neo4j 5.21+,
   present on this instance) preserves the outer row with nulls instead.

Also added `forceReleaseFileLock` (release by `lockId` only, no holder-identity
check — the admin/debug path) alongside the plan's `releaseFileLock`
(holder-checked) and `releaseFileLocksByExecution` (turn-end batch release).

**(b) Wiring into the then-current execution path.** §6 named the now-retired
`graph-sync.ts` end-of-turn
`ensureGraph`/`recordLineage` call site and `agent.execute-subagent.ts` as the
wiring points. In practice, files are only known AFTER the model decides to
edit them mid-turn (the fanout executor calls generic capabilities by name and
never sees target file paths itself), so a true *before-write* gate has to
live where the write actually happens: `write_file`/`edit_file` in
`packages/agent-engine/src/tools.ts`. This is also the ONE place shared by
every caller of `runCodingAgent` — the chat surface
(`apps/app/src/app/api/v1/chat/stream/route.ts`), the CLI, and
`agent.repo.edit` (dispatched both directly and as a subagent-fanout child) —
per `docs/adr/ADR-017-unified-agent-engine.md`'s shared engine, so wiring it
once here protects all of them without per-caller code. See:
`packages/agent-engine/src/ports.ts` (`FileLockProvider` port),
`packages/agent-engine/src/tools.ts` (acquire-before-write / release-after,
bounded retry, clear "Blocked" denial), `packages/agent-engine/src/pipeline/index.ts`
(one lock identity per turn, turn-end `releaseAll` backstop),
`packages/agent/src/adapters/file-lock.ts` (platform adapter), wired into
`packages/handlers/src/agent.repo.edit.ts`.

The restored `IntentLedger`/`LeaseManager`/`AgentCoordinator`
(`packages/engram/src/blackboard/`) were deliberately NOT touched in OXA-2070 —
they remained in-memory/single-process/unwired, exactly as PR #600 left them.
The graph-backed path wires directly into `tools.ts` instead of routing
through the blackboard, which is a cleaner fit than making the blackboard a
"thin client" of the contracts (§10's suggestion) since the coordinator's
`beforeWork`/`afterWork` shape doesn't map cleanly onto a per-tool-call
acquire/release.

**Update (OXA-2075): the blackboard module has been retired (deleted).**
`packages/engram/src/blackboard/` (and its re-exports from
`packages/engram/src/index.ts`) is gone as of this ticket. Rationale: it was
superseded by the graph-backed locks wired into `tools.ts` above; a repo-wide
consumer sweep (`grep` for the module path plus the bare class names
`IntentLedger`/`LeaseManager`/`AgentCoordinator`/`BlackboardBus` across
`packages/` and `apps/`) turned up zero real consumers outside the module's
own tests, so keeping it around would only be dead code per this repo's
prime directive. If a single-process, non-graph coordination primitive is
ever needed again, it is fully recoverable from git history at PR #541
(original add) / PR #600 (restore) — do not treat this as data loss.

**(c) Tests — done.** Unit tests for every mutation/handler/contract/adapter;
a `tools.file-lock.test.ts` + `pipeline.file-lock.test.ts` suite in
`packages/agent-engine` proving the acquire/release wiring including a
chat-vs-fleet-shaped race between two independent `runTurn` calls; a real-Neo4j
integration test (`packages/ontology/src/mutations/file-lock.integration.test.ts`)
covering race/renew/expiry/release/batch-release/sweep. No e2e — no
user-facing lock view was added in this ticket.

**(d) Capability parity — mostly done, two pieces deferred.**
`agent.file.lock.{acquire,release,list}` contracts + handlers + API routes +
MCP tools are shipped (`pnpm check:manifest --json` confirms schema/api/mcp/unit
all present). **Deferred as fast-follows:** `docs/capabilities/agent.file.lock.*.md`
+ `_index.md`, and a CLI command. Both are mechanical, low-risk additions
against the now-stable contracts.

**§9 item 8 (sweep) — done.** `agent.lease-sweep.ts`'s existing 5-minute cron
now also calls `sweepExpiredFileLocks()` as step 4, fail-soft (a Neo4j outage
here logs a warning and reports `fileLocksSwept: 0` rather than failing the
Postgres-backed lease sweep it shares a run with). Correctness never depended
on this cron running — `acquireFileLock`'s lazy-expiry predicate already makes
an expired lock invisible to new acquires — so this step is purely reclaiming
orphaned `HOLDS_LOCK` rows, same as documented in §6.
