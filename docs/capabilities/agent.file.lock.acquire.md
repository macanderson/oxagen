# agent.file.lock.acquire

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Acquire (or renew) an exclusive, TTL-bounded lock on a file so no two agents edit it concurrently. This is the SAME atomic Cypher (`@oxagen/ontology`'s `acquireFileLock`, via the `HOLDS_LOCK` edge) that `write_file`/`edit_file` in `packages/agent-engine/src/tools.ts` call automatically for every coding-agent turn — exposed here so a dashboard, a script, or a human debugging a stuck fleet can hold or probe a lock directly, without running a turn. Re-acquiring under the SAME `agentId` renews the lease (idempotent) instead of conflicting with itself; a DIFFERENT agent holding a live lock fails with `granted:false` rather than an error.

## Input

| Field | Type | Notes |
|---|---|---|
| `path` | `string` | File path (or naturalKey) to lock. |
| `owner` | `string` (optional) | GitHub owner — combined with `repo` to derive the `SourceFile` naturalKey, matching the coding-agent's own lock/lineage key. |
| `repo` | `string` (optional) | GitHub repo — see `owner`. |
| `action` | `"read" \| "write"` (optional) | Free-text action label stored on the lock edge (default `"write"`). |
| `ttlMs` | `number` (int, optional) | Lease length in ms (default 300000 = 5 minutes, mirrors `IntentLedger`'s TTL). Capped at 1 hour (3,600,000ms). |
| `agentId` | `string` (optional) | Identity to hold the lock as (default: the calling user/api-key id) — re-acquiring under the SAME `agentId` renews instead of conflicting. |
| `executionId` | `string` (optional) | Correlates this lock for a later batch/manual release (default: a fresh id). |

## Output

| Field | Type | Notes |
|---|---|---|
| `granted` | `boolean` | `true` when no other agent held a live lock on the file. |
| `lockId` | `string` | Empty string when not granted. |
| `heldBy` | `string \| null` | The conflicting holder's `agentId`, when `granted` is `false`. |
| `blockedUntil` | `number \| null` (int) | Epoch-ms the conflicting lock expires at, when `granted` is `false`. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Neo4j: `MERGE (:SourceFile {naturalKey, orgId})` (creating it with `is_system: true` if it doesn't already exist as a lineage node), then `MERGE (:Agent {id: agentId, orgId})-[:HOLDS_LOCK]->(:SourceFile)` and set `lockId`/`acquiredAt`/`expiresAt`/`workspaceId`/`action`/`executionId` on the edge — only when no OTHER agent holds a live (`expiresAt > now`) lock on the same file. A composite uniqueness constraint on `SourceFile(naturalKey, orgId)` serializes two concurrent acquires racing for the same file.
- When a conflicting lock exists, no edge is written — the call is a read of the conflicting holder's identity and expiry, not a mutation.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. empty `path`, `ttlMs` over the 1-hour cap). |
| `unauthorized` | Caller lacks the required org/workspace role. |

Note: a lock held by a different agent is NOT an error — it is a successful response with `granted: false`, `heldBy`, and `blockedUntil` populated so the caller can decide whether to wait or fail its own turn.
