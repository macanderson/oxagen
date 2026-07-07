# agent.file_lock.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Aliases:** `agent.file.lock.list` (pre-ADR-022 name; still resolves)

## Intent

List every currently-live file lock in the workspace, optionally filtered to
one file. Introspection for debugging a stuck fleet — a lock that outlives its
owning turn (crash before release) is visible here until its TTL lapses or the
sweep reaps it. Backed by the same Postgres lease table
(`agent.file_locks`, ADR-021 §5) as
[`agent.file_lock.acquire`](agent.file_lock.acquire.md); Neo4j plays no role in
this read — it only receives an async lineage projection on acquire.

## Input

| Field | Type | Notes |
|---|---|---|
| `path` | `string` (optional) | File path (or naturalKey) to filter to. Omit to list every live lock. |
| `owner` | `string` (optional) | GitHub owner — combined with `repo` + `path` to derive the naturalKey filter. |
| `repo` | `string` (optional) | GitHub repo — see `owner`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `locks` | `Lock[]` | Every currently-live lease, newest-acquired first. |
| `locks[].lockId` | `string` | Lock id, usable with `agent.file_lock.release`. |
| `locks[].naturalKey` | `string` | The locked resource's naturalKey (the lease's `resource_key`). |
| `locks[].agentId` | `string` | Identity currently holding the lease (the lease's `holder`). |
| `locks[].acquiredAt` | `number` (int) | Epoch-ms the lease was acquired (or last renewed). |
| `locks[].expiresAt` | `number` (int) | Epoch-ms the lease expires at. |
| `locks[].workspaceId` | `string` | Workspace the lease was acquired under. |
| `locks[].action` | `string` | Free-text action label stored at acquire time (e.g. `"read"`/`"write"`). |
| `locks[].executionId` | `string` | Execution/turn id that acquired the lease, for correlating a batch release. |

Note: the output does not carry the lease's `fencingToken` — call
[`agent.file_lock.acquire`](agent.file_lock.acquire.md) (same holder, to renew)
if the caller needs the current token for a resource.

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- None — read-only. Queries `agent.file_locks` (Postgres, RLS-scoped to the
  tenant via `withTenantDb`/`runInTenantScope`) for rows with
  `released_at IS NULL AND lease_expires_at > now()`, optionally filtered to a
  single `resource_key`.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |
