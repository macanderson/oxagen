# agent.memory.citations.stats

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Workspace-wide citation analytics across all executions: which memories and
graph nodes agents actually cite, how useful those citations were (influence),
and where rules get violated (compliance). Aggregates the Neo4j `:Citation`
graph — `(:Execution)-[:CITED]->(:Citation)-[:OF]->(:AgentMemory | :GraphNode)`
— the cross-execution rollup that `agent.memory.citations.list` (per-execution)
cannot answer. Backs the Knowledge → Citations dashboard. See
`docs/specs/two-axis-memory/DESIGN.md` §6/§7.

## Input

| Field   | Type        | Notes                                              |
| ------- | ----------- | -------------------------------------------------- |
| `days`  | `int 1–365` | Window in days for the daily series and totals. Default 30. |
| `limit` | `int 1–50`  | Max entries per top-N list. Default 10.            |

## Output

| Field                 | Type                              | Notes                                                                     |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------- |
| `totals`              | object                            | `citations`, distinct `executions`, `memoriesCited`, `nodesCited`.        |
| `byInfluence`         | `Record<string, number>`          | Citation count per influence level (DECISIVE/CONTRIBUTING/CONSIDERED/IGNORED). |
| `byCompliance`        | `Record<string, number>`          | Citation count per compliance outcome (COMPLIED/DISCRETION/VIOLATION/NA).  |
| `daily`               | `{ date, citations, violations }[]` | Zero-filled per-day series across the window.                             |
| `topMemories`         | `CitedMemoryStat[]`               | Most-cited memories, with influence breakdown.                            |
| `leastUsefulMemories` | `CitedMemoryStat[]`               | Cited ≥3 times but never DECISIVE/CONTRIBUTING.                            |
| `mostViolatedRules`   | `CitedMemoryStat[]`               | RULE/FACT memories ranked by violation citations.                         |
| `topNodes`            | `{ node, citationCount, … }[]`    | Most-cited non-memory graph nodes, resolved to human-label refs.          |

`AgentMemory` nodes also carry the `:GraphNode` label, so node-scoped
aggregations exclude `:AgentMemory`. `topNodes` resolves each node server-side to
the `knowledgeNodeRef` shape (`{ id, label, displayName, properties }`,
coalescing `displayName→name→publicId`) — never a bare id.

## Side effects

- None (read-only). Returns an empty-but-valid rollup when the knowledge graph is not configured.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §6/§7
