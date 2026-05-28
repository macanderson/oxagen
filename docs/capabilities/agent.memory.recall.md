# agent.memory.recall

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Query Neo4j `AgentMemory` nodes by semantic similarity plus a weight
threshold. Returns ranked memories scoped to the active workspace.
This is the read side of the memory contract defined in the
`oxagen-feature` skill.

## Input

| Field       | Type                                | Notes                                            |
| ----------- | ----------------------------------- | ------------------------------------------------ |
| `query`     | `string` (>= 1)                     | Natural-language query.                          |
| `minWeight` | `"low" \| "high" \| "critical"`     | Lower bound on memory weight. Defaults to `high`. |
| `limit`     | `number` (1 – 50)                   | Result cap. Defaults to 10.                      |
| `nodeRef`   | `string?`                           | Anchor the query at one graph node ref.          |

## Output

| Field      | Type                                                                                | Notes                  |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------- |
| `memories` | `Array<{ id, nodeRef, weight, kind, lesson, source, score, createdAt }>`            | Ranked memory matches. |

## Side effects

None — read-only against Neo4j.

## Errors

| code              | meaning                                          |
| ----------------- | ------------------------------------------------ |
| `graph_unavailable` | Neo4j unreachable.                             |

## SPEC references

- §3 — memory recall
- §4 — new capabilities
- `oxagen-feature` skill — memory weighting contract
