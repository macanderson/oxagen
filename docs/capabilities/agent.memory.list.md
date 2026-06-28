# agent.memory.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Enumerate the `AgentMemory` nodes a workspace has accumulated in Neo4j,
newest first, with optional weight / kind / node filters. This is the
non-semantic **browse** counterpart to `agent.memory.recall`: recall needs a
query string to vector-search, whereas the Knowledge → Memories surface needs
to list everything that exists.

Both `agent.memory.list` and `agent.memory.recall` read the same Neo4j
`:AgentMemory` nodes written by `agent.memory.write`, so every surface (API,
MCP, in-app agent, the Knowledge → Memories tab) sees an identical memory set
with no store drift.

## Input

| Field       | Type                                                                              | Notes                                                  |
| ----------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `nodeRef`   | `string?`                                                                         | Scope to memories anchored on a single graph node ref. |
| `minWeight` | `"low" \| "high" \| "critical"`?                                                  | Only return memories at or above this weight.          |
| `kind`      | `"routine-change" \| "constraint" \| "bug-root-cause" \| "convention-deviation" \| "gotcha"`? | Filter to a single memory kind.            |
| `limit`     | `number` (1 – 200)                                                                | Page size. Defaults to 100.                            |
| `offset`    | `number` (>= 0)                                                                   | Page offset. Defaults to 0.                            |

## Output

| Field      | Type                                                                                                          | Notes                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `memories` | `Array<{ id, publicId, nodeRef, weight, kind, lesson, source, confidence, createdAt, lastReinforcedAt }>`      | The page, newest first.                            |
| `total`    | `number`                                                                                                       | Total matching memories for the tenant, ignoring `limit`/`offset`. |

## Side effects

None — read-only against Neo4j. Unlike `agent.memory.recall`, it does **not**
reinforce or decay the memories it returns.

## Errors

| code                | meaning            |
| ------------------- | ------------------ |
| `graph_unavailable` | Neo4j unreachable. |

When the knowledge graph is not configured the handler returns an empty page
(`{ memories: [], total: 0 }`) rather than erroring.

## SPEC references

- §3 — memory browse / list
- §4 — new capabilities
- `oxagen-feature` skill — memory weighting contract
