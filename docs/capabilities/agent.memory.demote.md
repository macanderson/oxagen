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

## Examples

API — demote a rule back to an observation (rationale optional):

```bash
curl -X POST "https://api.oxagen.sh/v1/{org_slug}/{workspace_slug}/agent/memory/demote" \
  -H "Authorization: Bearer $OXAGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"memoryId": "mem_01H…", "toClass": "OBSERVATION", "rationale": "never influential in 30 days of citations"}'
```

API — demote a FACT to a RULE with explicit enforcement (omitting `enforcementScore` defaults it to 50):

```bash
curl -X POST "https://api.oxagen.sh/v1/{org_slug}/{workspace_slug}/agent/memory/demote" \
  -H "Authorization: Bearer $OXAGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"memoryId": "mem_01H…", "toClass": "RULE", "enforcementScore": 60}'
```

MCP — tool `demote_memory` with the same input shape:

```json
{ "memoryId": "mem_01H…", "toClass": "RULE", "enforcementScore": 60 }
```

App: Knowledge → Memory → open a RULE/FACT memory → **Demote** in the detail sheet.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §4
