# agent.memory.demote

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium (requires approval)

## Intent

Move a memory _down_ the confidence ladder — FACT → RULE → OBSERVATION —
recording an auditable `:Demotion` event. The inverse of `agent.memory.promote`.
The target class must be strictly below the memory's current class. See
`docs/specs/two-axis-memory/DESIGN.md` §4.

## Input

| Field              | Type                       | Notes                                                                 |
| ------------------ | -------------------------- | --------------------------------------------------------------------- |
| `memoryId`         | `string`                   | The AgentMemory node id to demote.                                    |
| `toClass`          | `"RULE" \| "OBSERVATION"`  | Target class; must be below the current class (FACT is not a target). |
| `enforcementScore` | `int 1–100`?               | Enforcement to set when demoting to RULE; ignored for OBSERVATION.    |
| `rationale`        | `string` (1–1000)?         | Optional: why the memory is being demoted.                            |

## Output

`AgentMemoryRecord` — the updated memory.

## Invariants (enforced server-side)

- Direction is strictly downward (FACT→RULE, FACT→OBSERVATION, RULE→OBSERVATION); an upward or same-class target is rejected.
- OBSERVATION ⟹ enforcement `null`.
- RULE ⟹ enforcement `enforcementScore ?? 50`.
- Leaving FACT clears the human-confirmation fields (`confirmed_by_kind`/`confirmed_by_id`).

## Side effects

- Neo4j: create `(:Demotion)-[:DEMOTED]->(:AgentMemory)`; update class/enforcement/confirmation.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §4
