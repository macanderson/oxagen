# agent.memory.import.commit

**Domain:** agent
**Mode:** sync (batch)
**Scope:** organization + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Write confirmed and optionally edited draft memories (from `agent.memory.import.parse`) into the workspace's AgentMemory Neo4j graph. Each lesson is embedded and written independently; per-item errors are captured rather than failing the entire batch. Results are positional—`results[i]` corresponds to `drafts[i]` in the input.

## Access control

Requires `org.Owner` or `org.Admin`, plus `workspace.Owner` or `workspace.Member`.
Default effect: deny.

## Input

| Field   | Type                                      | Notes                                                 |
| ------- | ----------------------------------------- | ----------------------------------------------------- |
| `drafts` | `Array<Draft>` (1 – 200 items)            | Memory drafts from `agent.memory.import.parse`, optionally edited. |

### Draft shape (same as `agent.memory.import.parse` output)

| Field             | Type                                                                          | Notes                                                           |
| ----------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `lesson`          | `string` (1 – 2000)                                                           | The memory lesson, in prose.                                   |
| `memoryClass`     | `"OBSERVATION" \| "RULE" \| "FACT"`                                           | Epistemic class.                                                |
| `memoryKind`      | `string`                                                                      | Content domain (extensible).                                    |
| `enforcementScore`| `int 1–100`?                                                                  | Enforcement when class is RULE.                                 |
| `source`          | `"user"`                                                                      | Provenance marker.                                              |
| `nodeRef`         | `string`                                                                      | Graph node ref the memory anchors to.                          |
| `sourceDocument`  | `string`                                                                      | Original source document filename.                             |
| `classified`      | `boolean`                                                                     | Always `true` for committed imports.                           |

## Output

| Field      | Type                                                                                                 | Notes                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `results`  | `Array<{ lesson: string; ok: boolean; memoryId: string \| null; error: string \| null }>`          | Per-item write result, positional with input `drafts`.           |
| `imported` | `number`                                                                                             | Count of successfully written memories.                          |
| `failed`   | `number`                                                                                             | Count of memories that failed to write.                          |

### Result item shape

| Field      | Type              | Notes                                                                                  |
| ---------- | ----------------- | -------------------------------------------------------------------------------------- |
| `lesson`   | `string`          | Echo of the input lesson (for reference).                                             |
| `ok`       | `boolean`         | `true` if the memory was written; `false` if an error occurred.                      |
| `memoryId` | `string \| null`  | The prefixed memory ID (`mem_*`) if write succeeded; `null` if write failed.          |
| `error`    | `string \| null`  | Error message if write failed; `null` if write succeeded.                             |

## Side effects

- Neo4j: for each successful draft, MERGE an `(:AgentMemory)` with the given memoryClass, memoryKind, enforcementScore, lesson, and source, plus `:ABOUT` edges.
- ClickHouse: emit one `agent.memory.imported` row per successfully written memory.
- Failed writes emit no side effects; the draft is not persisted.

## Errors

| code               | meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `draft_limit_exceeded` | More than 200 drafts provided.                   |
| `graph_unavailable` | Neo4j unreachable.                                 |
| `ai_embedding_failed` | AI gateway failed to embed a lesson (soft error, appears in per-item `error`). |

## Notes

- Write failures are **per-item and non-fatal**. If one memory fails to embed or write, others continue.
- Results array preserves the input order; callers can correlate failures to their original drafts.
- Each successful memory is embedded by the AI gateway and stored in Neo4j alongside the original lesson text.
- Memories written via `agent.memory.import.commit` have `source: "user"`, distinguishing them from agent-learned memories.
- The same Neo4j store is used for all memory types (imported, agent-learned, etc.); `agent.memory.list`, `agent.memory.recall`, and agent memory recall during reasoning all see the full set.

## SPEC references

- Agent memory import contract
- Memory write and persistence (`agent.memory.write`)
- Memory retrieval and ranking (`agent.memory.list`, `agent.memory.recall`)
