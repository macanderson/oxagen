# agent.memory.promote

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium (requires approval)

## Intent

Move a memory up the confidence ladder — OBSERVATION → RULE → FACT — recording
an auditable `:Promotion` event. Promotion is the only path that changes a
memory's `memoryClass`: it sets the `enforcementScore` (policy) and, for FACT,
requires human confirmation. See `docs/specs/two-axis-memory/DESIGN.md` §4.

## Input

| Field                | Type                  | Notes                                                        |
| -------------------- | --------------------- | ----------------------------------------------------------- |
| `memoryId`           | `string`              | The AgentMemory node id to promote.                          |
| `toClass`            | `"RULE" \| "FACT"`    | Target class (OBSERVATION is not a promotion target).        |
| `enforcementScore`   | `int 1–100`?          | Enforcement for a RULE; ignored for FACT (forced 100).       |
| `rationale`          | `string` (1–1000)?    | Optional: why the memory is being promoted.                  |
| `basedOnEvidenceIds` | `string[]`? (≤50)     | Evidence node ids → `:BASED_ON` edges.                       |

## Output

`AgentMemoryRecord` — the updated memory.

## Invariants (enforced server-side)

- FACT ⟹ confirmed by a USER + enforcement 100.
- RULE ⟹ enforcement 1–100.

## Side effects

- Neo4j: create `(:Promotion)-[:PROMOTED]->(:AgentMemory)` (+ `:BASED_ON` edges); update class/enforcement/confirmation.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §4
