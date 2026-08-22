# agent.memory.remember

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

The one-shot "just remember this" entry point. Where `agent.memory.write` demands every field up front, `remember` takes raw text and infers the memory `kind` and `class`/`weight` with a small classifier when the caller does not pin them, then embeds and writes the result. It backs the `/remember <text>` shorthand, so a human can capture a lesson without learning the weight/kind taxonomy. The write lands on the workspace-scoped Neo4j `:AgentMemory` store — the same nodes `agent.memory.list`/`recall` read — so a captured memory is immediately visible in Knowledge → Memories.

## Input

| Field | Type | Notes |
|---|---|---|
| `text` | `string` (1–2000) | The lesson to remember, in the user's own words. |
| `nodeRef?` | `string` | Graph node id to anchor the memory on. Defaults to the `user-memory` bucket for free-form notes with no code anchor. |
| `memoryClass?` | `"OBSERVATION" \| "RULE" \| "FACT"` | Pin the epistemic class; omit to let the classifier infer it (defaults to OBSERVATION). |
| `memoryKind?` | `string` (1–64) | Pin the content-domain kind; omit to let the classifier infer it. |
| `enforcementScore?` | `int 1–100` | Enforcement when `memoryClass` is RULE. |
| `source` | `"user" \| "feature" \| "fix" \| "exception-watcher" \| "bug-report"` | Provenance; defaults to `user` for a human-captured memory. |
| `relatedNodeIds?` | `string[]` (≤20) | KnowledgeNode publicIds this memory is about — creates `:ABOUT` edges. |

## Output

| Field | Type | Notes |
|---|---|---|
| `memory` | `AgentMemoryRecord` | The written memory record (id, publicId, nodeRef, class, kind, lesson, confidence/enforcement scores, status, timestamps — see `agent.memory.model`). |
| `inferred.memoryClass` | `"OBSERVATION" \| "RULE" \| "FACT"` | The epistemic class actually used. |
| `inferred.memoryKind` | `string` | The content-domain kind actually used. |
| `inferred.classified` | `boolean` | `true` when class/kind were inferred by the model rather than supplied or defaulted. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Neo4j: writes an `:AgentMemory` node to the workspace memory graph and creates `:ABOUT` edges for any `relatedNodeIds`.
- Embeddings: computes and stores a semantic embedding of the lesson for recall.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. empty text, RULE without enforcement). |
| `unauthorized` | Caller lacks the required org/workspace role. |
