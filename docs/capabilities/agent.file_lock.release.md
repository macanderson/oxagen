# agent.file_lock.release

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Aliases:** `agent.file.lock.release` (pre-ADR-022 name; still resolves)

## Intent

Force-release a file lock by its `lockId` — the admin/debug path for clearing
a lock a crashed or stuck agent left behind before its TTL lapses. Unlike the
per-turn release the coding agent runs on its own behalf (which also checks
the holder), this matches by `lockId` alone, so an operator can clear someone
else's stuck lock without knowing the original holder's internal identity.
Gated to Owner/Admin (and workspace Owner, not Member) precisely because it
bypasses the holder check.

Backed by the Postgres lease (`agent.file_locks`, ADR-021 §5) — see
[`agent.file_lock.acquire`](agent.file_lock.acquire.md) for how the lease is
acquired and why Postgres, not Neo4j, is the lock authority.

## Input

| Field | Type | Notes |
|---|---|---|
| `lockId` | `string` | The `lockId` returned by `agent.file_lock.acquire` or `agent.file_lock.list`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `released` | `boolean` | `false` when no matching lock existed — idempotent no-op, not an error. |

## Roles

Org Owner, Org Admin, Workspace Owner. (Workspace Member cannot force-release.)

## Side effects

- Postgres: marks the matching `agent.file_locks` row released (by `id` /
  `lockId` alone — no `holder` check, and no requirement that the lease still
  be live; an already-expired row with a matching `lockId` is still released
  if present).
- The resource's fencing counter (`agent.file_lock_fences`) is left untouched
  — releasing does not roll back or reset the token, so the next acquire still
  issues a strictly higher fencing token than any prior holder held.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. empty `lockId`). |
| `unauthorized` | Caller lacks the required org/workspace role (Member is always denied). |

Note: releasing a `lockId` that doesn't exist (already released, expired and reaped, or never valid) is NOT an error — it returns `released: false`.
