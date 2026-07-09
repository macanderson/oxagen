# agent.memory.update

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Edit an existing `AgentMemory` in place: change the lesson text, re-categorise the kind/source, and adjust salience (the numeric `confidenceScore` and `enforcementScore`) or lifecycle status. When the lesson changes the handler re-embeds so semantic recall stays accurate against the new text. `memoryId` is the node id (not publicId); all other fields are optional, and the handler rejects a call that changes nothing. Class changes go through `agent.memory.promote`, not here.

## Input

| Field | Type | Notes |
|---|---|---|
| `memoryId` | `string` | The `AgentMemory` node id (not publicId) to update. |
| `lesson?` | `string` (1–2000) | Replacement lesson text; triggers a re-embed for semantic recall. |
| `memoryKind?` | `string` (1–64) | New content-domain kind. |
| `source?` | `string` (1–64) | New provenance label (e.g. `user`, `feature`, `fix`). |
| `confidenceScore?` | `number 0–100` | New confidence; the decay pass evolves it over time. |
| `enforcementScore?` | `int 1–100` | New enforcement for a RULE; policy, does not decay. |
| `status?` | `"ACTIVE" \| "SUPERSEDED" \| "RETRACTED" \| "ARCHIVED"` | New lifecycle status. |

## Output

| Field | Type | Notes |
|---|---|---|
| `AgentMemoryRecord` | `object` | The updated memory record (id, publicId, nodeRef, class, kind, lesson, source, confidence/enforcement scores, status, counts, timestamps — see `agent.memory.model`). |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Neo4j: updates the `:AgentMemory` node's properties in the workspace memory graph.
- Embeddings: re-embeds the lesson when its text changes.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse, or the call changed nothing. |
| `not_found` | No memory matches `memoryId` in this workspace. |
| `unauthorized` | Caller lacks the required org/workspace role. |
