# agent.memory.evidence.attach

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Attach a corroborating (or refuting) `:Evidence` node to a memory and adjust its
`confidenceScore`. Supporting evidence pulls confidence up by `strength × 100`
(capped 100) and refreshes the decay clock; refuting evidence pulls it down
(floored 0). This is how confidence recovers between decay passes. See
`docs/specs/two-axis-memory/DESIGN.md` §5, §7b.

## Input

| Field        | Type                                                              | Notes                                     |
| ------------ | ---------------------------------------------------------------- | ----------------------------------------- |
| `memoryId`   | `string`                                                         | Memory to attach evidence to.             |
| `sourceKind` | `CITATION \| HUMAN_CONFIRM \| CODE_SCAN \| AGENT_JUDGE \| REPEAT_OBSERVATION` | What kind of signal.         |
| `strength`   | `number 0–1`                                                     | Confidence moves by `strength × 100`.     |
| `detail`     | `string?`                                                        | Free-text detail.                         |
| `refutes`    | `boolean` (default false)                                       | true = negative evidence (`:REFUTES`).    |

## Output

`{ evidenceId, confidenceScore }` — the new confidence after the adjustment.

## Side effects

- Neo4j: create `(:Evidence)-[:SUPPORTS|:REFUTES]->(:AgentMemory)`; adjust confidence + last_evidence_at.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §5, §7b
