# agent.file.lock.release

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Force-release a file lock by its `lockId` — the admin/debug path for clearing a lock a crashed or stuck agent left behind before its TTL lapses. Unlike the per-turn release the coding agent runs on its own behalf (which also checks the holder's `agentId`), this matches by `lockId` alone, so an operator can clear someone else's stuck lock without knowing the original holder's internal identity. Gated to Owner/Admin (and workspace Owner, not Member) precisely because it bypasses the holder check.

## Input

| Field | Type | Notes |
|---|---|---|
| `lockId` | `string` | The `lockId` returned by `agent.file.lock.acquire` or `agent.file.lock.list`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `released` | `boolean` | `false` when no matching lock existed — idempotent no-op, not an error. |

## Roles

Org Owner, Org Admin, Workspace Owner. (Workspace Member cannot force-release.)

## Side effects

- Neo4j: `MATCH (:Agent)-[h:HOLDS_LOCK {lockId}]->(:SourceFile)` scoped to the tenant, then `DELETE h`. Matches on `lockId` only — no `agentId` check, and no requirement that the lock still be live (an already-expired lock with a matching `lockId` is still deleted if present).

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. empty `lockId`). |
| `unauthorized` | Caller lacks the required org/workspace role (Member is always denied). |

Note: releasing a `lockId` that doesn't exist (already released, expired and reaped, or never valid) is NOT an error — it returns `released: false`.
