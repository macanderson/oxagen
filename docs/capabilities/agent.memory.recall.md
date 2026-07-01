# agent.memory.recall

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Query ACTIVE `:AgentMemory` nodes by semantic similarity, with optional
epistemic-class and enforcement filters. Results are gated by the workspace
recall confidence threshold and ranked by vector score. Recalling a memory is
itself weak evidence — it nudges the memory's `confidenceScore` up (recovery)
and refreshes its decay clock.

## Input

| Field            | Type                                | Notes                                              |
| ---------------- | ----------------------------------- | -------------------------------------------------- |
| `query`          | `string` (>= 1)                     | Natural-language query; embedded for vector search.|
| `memoryClass`    | `"OBSERVATION" \| "RULE" \| "FACT"`? | Only recall this class.                           |
| `minEnforcement` | `int 1–100`?                        | Only recall rules at or above this enforcement.    |
| `limit`          | `number` (1 – 50)                   | Result cap. Defaults to 10.                        |
| `nodeRef`        | `string?`                           | Anchor the query at one graph node ref.            |

## Output

| Field      | Type | Notes |
| ---------- | ---- | ----- |
| `memories` | `Array<{ id, nodeRef, memoryClass, memoryKind, lesson, source, confidenceScore, enforcementScore, score, createdAt }>` | Ranked matches. |

## Side effects

- Neo4j: fire-and-forget confidence recovery (+ decay-clock refresh) on each recalled memory.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md`
