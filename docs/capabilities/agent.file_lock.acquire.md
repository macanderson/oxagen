# agent.file_lock.acquire

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Aliases:** `agent.file.lock.acquire` (pre-ADR-022 name; still resolves)

## Intent

Acquire (or renew) an exclusive, TTL-bounded lock on a file so no two agents
edit it concurrently. This is the SAME atomic **Postgres lease** (ADR-021 §5,
`packages/agent/src/file-lock/lease.ts`) that `write_file`/`edit_file` in
`packages/agent-engine/src/tools.ts` acquire automatically for every
coding-agent turn — exposed here so a dashboard, a script, or a human
debugging a stuck fleet can hold or probe a lock directly, without running a
turn. Re-acquiring under the SAME `agentId` renews the lease (idempotent)
instead of conflicting with itself; a DIFFERENT agent holding a live lock
fails with `granted:false` rather than an error.

**Postgres, not Neo4j, is the lock authority.** File locking is
mutual-exclusion state, and the graph projection path is asynchronous —
a lock "written to the graph" would be invisible to a concurrent agent for the
duration of sync lag, which is fatal for mutual exclusion. The lease lives in
the tenant-scoped `agent.file_locks` table (RLS-enforced via
`withTenantDb`/`runInTenantScope`); every successful acquire also fires an
async, best-effort Neo4j projection for lineage/visualization only — never for
correctness.

## Input

| Field | Type | Notes |
|---|---|---|
| `path` | `string` | File path (or naturalKey) to lock. |
| `owner` | `string` (optional) | GitHub owner — combined with `repo` to derive the `SourceFile` naturalKey, matching the coding-agent's own lock/lineage key. |
| `repo` | `string` (optional) | GitHub repo — see `owner`. |
| `action` | `"read" \| "write"` (optional) | Free-text action label stored on the lease (default `"write"`). |
| `ttlMs` | `number` (int, optional) | Lease length in ms (default 300000 = 5 minutes). Capped at 1 hour (3,600,000ms). |
| `agentId` | `string` (optional) | Identity to hold the lock as (default: the calling user/api-key id) — re-acquiring under the SAME `agentId` renews instead of conflicting. |
| `executionId` | `string` (optional) | Correlates this lock for a later batch/manual release (default: a fresh id). |

## Output

| Field | Type | Notes |
|---|---|---|
| `granted` | `boolean` | `true` when no other agent held a live lease on the resource. |
| `lockId` | `string` | Empty string when not granted. |
| `heldBy` | `string \| null` | The conflicting holder's `agentId`, when `granted` is `false`. |
| `blockedUntil` | `number \| null` (int) | Epoch-ms the conflicting lease expires at, when `granted` is `false`. |
| `fencingToken` | `number \| null` (int) | Monotonic per-resource fencing token for a granted lease (ADR-021 §5). A takeover after expiry always issues a strictly higher token than any prior holder held, so a stale holder's late write can be rejected at write time. `null` when not granted. |

## How it works (Postgres lease, ADR-021 §5)

1. **Read-only conflict pass, inside one transaction.** For every requested resource key, the transaction takes a Postgres advisory lock (`pg_advisory_xact_lock`, keyed on `workspaceId:resourceKey`, resources processed in sorted order so two concurrent multi-key acquires can't deadlock on lock ordering) and checks `agent.file_locks` for a live foreign holder (`released_at IS NULL AND lease_expires_at > now() AND holder <> caller`).
2. **All-or-nothing.** If ANY requested key conflicts, nothing is acquired and no fence is bumped — the whole call is a no-op read.
3. **Fence bump + upsert.** When nothing conflicts, `agent.file_lock_fences` (a durable per-resource monotonic counter) is incremented and `agent.file_locks` is upserted (`ON CONFLICT` on the partial unique index over live rows) with the new `fencing_token`, holder, and expiry.
4. **Async lineage projection.** After the transaction commits, the newly-held lease is projected onto the Neo4j graph fire-and-forget (never awaited before returning) purely for lineage visualization — it plays no role in the mutual-exclusion decision.

An expired-but-unreleased row is free for takeover; a scheduled sweep also reaps expired rows for hygiene.

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Postgres: inserts/updates a row in `agent.file_locks` and increments `agent.file_lock_fences` for the resource — only when no OTHER agent holds a live lease on it.
- Neo4j: best-effort, asynchronous lineage projection of the lock event (not part of the mutual-exclusion guarantee).
- When a conflicting lease exists, no row is written — the call is a read of the conflicting holder's identity and expiry, not a mutation.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. empty `path`, `ttlMs` over the 1-hour cap). |
| `unauthorized` | Caller lacks the required org/workspace role. |

Note: a lock held by a different agent is NOT an error — it is a successful response with `granted: false`, `heldBy`, and `blockedUntil` populated so the caller can decide whether to wait or fail its own turn.
