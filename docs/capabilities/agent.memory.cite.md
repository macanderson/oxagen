# agent.memory.cite

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Record that an execution retrieved and used memories — the influence/compliance
mechanism. Captures the counterfactual: did each memory shape the output
(`influence`), and for rules, was it complied with given its enforcement
(`compliance`, derived server-side from enforcement, the `deviated` flag, and the
workspace compliance threshold). MERGEs the `:Execution`, writes a `:Citation`
per memory, and maintains the citation / influence / violation counters. See
`docs/specs/two-axis-memory/DESIGN.md` §6.

## Input

| Field          | Type                          | Notes                                              |
| -------------- | ----------------------------- | -------------------------------------------------- |
| `executionRef` | `string`                      | Execution id; created (MERGE) if absent.           |
| `agentId`      | `string?`                     | Executing agent.                                   |
| `runId`        | `string?`                     | Run id.                                            |
| `taskSummary`  | `string?`                     | Human summary of the execution.                    |
| `citations`    | `Array<CitationInput>` (1–100)| One per cited memory (see below).                  |

`CitationInput`: `{ memoryId, influence: DECISIVE|CONTRIBUTING|CONSIDERED|IGNORED, deviated: bool, expectedValue?, observedValue?, agentRationale? }`.

## Output

`{ executionId, results: Array<{ memoryId, ok, citationId|null, compliance, error|null }>, recorded }`.
`compliance` ∈ `COMPLIED | DISCRETION | VIOLATION | NA`.

## Side effects

- Neo4j: MERGE `:Execution`; create `(:Execution)-[:CITED]->(:Citation)-[:OF]->(:AgentMemory)`; increment citation/influence/violation counters.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §6, §7f
