# agent.memory.citations.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List the memory citations recorded for an execution. Filter by `compliance`
(e.g. VIOLATION — which rules were broken) or `influence` (e.g. DECISIVE /
CONTRIBUTING — what actually shaped the output). The read side of the
citation mechanism; feeds future evals. See
`docs/specs/two-axis-memory/DESIGN.md` §7d, §7e.

## Input

| Field         | Type                                    | Notes                                       |
| ------------- | --------------------------------------- | ------------------------------------------- |
| `executionId` | `string`                                | Execution to list citations for.            |
| `compliance`  | `COMPLIED \| DISCRETION \| VIOLATION \| NA`? | Filter to one compliance outcome.       |
| `influenceIn` | `Influence[]`?                          | Filter to these influence levels.           |

## Output

`citations[]`: `{ citationId, memoryId, lesson, influence, compliance, enforcementAtCite, expectedValue, observedValue, agentRationale }`.

## Side effects

None — read-only.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §7d, §7e
