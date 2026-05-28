# agent.memory.write

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Persist a weighted memory tied to a graph node per the
`oxagen-feature` skill's memory contract. Memories are the durable
record of what an agent learned during a task; later turns recall
them via `agent.memory.recall`.

## Input

| Field      | Type                                                                                            | Notes                                                |
| ---------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `nodeRef`  | `string`                                                                                        | Graph node ref the memory anchors to.                |
| `weight`   | `"low" \| "high" \| "critical"`                                                                 | Retrieval weight.                                    |
| `kind`     | `"routine-change" \| "constraint" \| "bug-root-cause" \| "convention-deviation" \| "gotcha"`    | Memory category.                                     |
| `lesson`   | `string` (1 – 2000)                                                                             | The actual lesson, in prose.                         |
| `source`   | `"feature" \| "fix" \| "exception-watcher" \| "bug-report"`                                     | Provenance.                                          |

## Output

| Field      | Type     | Notes                              |
| ---------- | -------- | ---------------------------------- |
| `memoryId` | `string` | Prefixed with `mem_`.              |
| `nodeRef`  | `string` | Echoes the anchored node ref.      |

## Side effects

- Neo4j: create `(:AgentMemory)-[:ABOUT]->(:GraphNode { ref })`.
- ClickHouse: emit `agent.memory.written` row.

## Errors

| code              | meaning                                          |
| ----------------- | ------------------------------------------------ |
| `unknown_node`    | `nodeRef` does not resolve to a graph node.      |
| `graph_unavailable` | Neo4j unreachable.                             |

## SPEC references

- §3 — memory write
- §4 — new capabilities
- `oxagen-feature` skill — memory weighting contract
