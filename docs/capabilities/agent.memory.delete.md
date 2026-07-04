# agent.memory.delete

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Permanently delete an `AgentMemory` node (and its edges) by id. This is a hard `DETACH DELETE` — the node and its `REMEMBERS`/`ABOUT` edges are gone, not merely decayed below the recall threshold. Destructive: prefer `agent.memory.update` to lower salience when you only want a memory to stop surfacing. The verb carries a destructive agent posture (`requiresApproval`) and a higher risk level than write/update.

## Input

| Field | Type | Notes |
|---|---|---|
| `memoryId` | `string` | The `AgentMemory` node id (not publicId) to delete. |

## Output

| Field | Type | Notes |
|---|---|---|
| `deleted` | `boolean` | `true` when a memory matched and was deleted; `false` when none matched in this workspace. |
| `memoryId` | `string` | Echoes the requested memory id. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Neo4j: `DETACH DELETE` of the `:AgentMemory` node and its `:REMEMBERS`/`:ABOUT` edges from the workspace-scoped memory graph.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. empty `memoryId`). |
| `unauthorized` | Caller lacks the required org/workspace role. |
