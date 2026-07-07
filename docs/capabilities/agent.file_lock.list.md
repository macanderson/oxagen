# agent.file.lock.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List every currently-live file lock in the workspace, optionally filtered to one file. Introspection for debugging a stuck fleet — a lock that outlives its owning turn (crash before release) is visible here until its TTL lapses or the sweep reaps it.

## Input

| Field | Type | Notes |
|---|---|---|
| `path` | `string` (optional) | File path (or naturalKey) to filter to. Omit to list every live lock. |
| `owner` | `string` (optional) | GitHub owner — combined with `repo` + `path` to derive the naturalKey filter. |
| `repo` | `string` (optional) | GitHub repo — see `owner`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `locks` | `Lock[]` | Every currently-live lock, newest-acquired first. |
| `locks[].lockId` | `string` | Lock id, usable with `agent.file.lock.release`. |
| `locks[].naturalKey` | `string` | The locked `SourceFile`'s naturalKey. |
| `locks[].agentId` | `string` | Identity currently holding the lock. |
| `locks[].acquiredAt` | `number` (int) | Epoch-ms the lock was acquired (or last renewed). |
| `locks[].expiresAt` | `number` (int) | Epoch-ms the lock expires at. |
| `locks[].workspaceId` | `string` | Workspace the lock was acquired under. |
| `locks[].action` | `string` | Free-text action label stored at acquire time (e.g. `"read"`/`"write"`). |
| `locks[].executionId` | `string` | Execution/turn id that acquired the lock, for correlating a batch release. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- None — read-only. Neo4j MATCH of `(:Agent)-[:HOLDS_LOCK]->(:SourceFile)` edges scoped to the tenant, filtered to `expiresAt > now` (and to `naturalKey` when a `path` filter is given).

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |
