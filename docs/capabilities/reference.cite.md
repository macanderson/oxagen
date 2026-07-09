# reference.cite

**Domain:** reference
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** agent
**Risk level:** low

## Intent

Record that a chat turn deliberately referenced knowledge-graph nodes
via `@`-mentions. A manual mention is a citation: the turn's `:Execution`
is MERGEd, then per mentioned node a `:Citation` (source `mention`,
influence `DECISIVE` — the user attached it on purpose) is written and
linked `(execution)-[:CITED]->(citation)-[:OF]->(node)`, incrementing the
node's `citation_count` — the same counter the agent's automatic memory
citations maintain, so manual and automatic references accrue
identically. `:AgentMemory` nodes additionally get `influence_count`
bumped, matching `cite_memory`'s DECISIVE semantics.

Agent-surface only: invoked fire-and-forget by chat routes while weaving
mention context into a turn; not a user-facing API/MCP action.

## Input

| Field          | Type                     | Notes                                                            |
| -------------- | ------------------------ | ---------------------------------------------------------------- |
| `executionRef` | `string`                 | Execution id (chat turn messageId) to attach citations to; MERGEd if absent. |
| `agentId`      | `string?`                | Optional agent id recorded on the execution.                     |
| `taskSummary`  | `string?`                | Optional turn summary (≤500 chars).                              |
| `references`   | `Array<{ nodeId }>`      | 1–32 mentioned node publicIds to cite.                          |

## Output

| Field         | Type                                                       | Notes                                                    |
| ------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| `executionId` | `string`                                                   | Resolved execution id (`""` when the graph is disabled). |
| `results`     | `Array<{ nodeId, ok, citationId, error }>`                 | Per-reference outcome (never all-or-nothing).            |
| `recorded`    | `number`                                                   | Count of citations actually written.                     |

## Side effects

Writes `:Citation` lineage into Neo4j and increments the cited node's
`citation_count` (plus `influence_count` for `:AgentMemory` nodes). A
missing node fails only its own result row; the handler never throws for
one bad reference. When the workspace has no knowledge graph configured,
the call is a no-op — every reference returns `ok: false` and `recorded`
is 0.

## Errors

Per-reference failures are captured in the corresponding `results` row's
`error` (node not found, or a citation-write failure). Auth / scope
failures are handled by middleware.

## SPEC references

- `@oxagen/ai` `mentions` — the `@`-mention reference grammar that produces cited node ids
- Agent memory citations — `recordMentionCitation` mirrors `recordCitation` counter maintenance
