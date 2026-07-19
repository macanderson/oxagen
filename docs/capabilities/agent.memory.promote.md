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

## Rationale is optional

The rationale is a recorded justification, not a gate. The human gate for FACT
is confirmation (in the app: the acknowledgement checkbox); RULE promotions need
nothing beyond the request itself. When you do want a rationale on record but
not the typing, `suggest_promotion_rationales` drafts context-grounded options
to pick from.

## Examples

API — promote to RULE with no rationale:

```bash
curl -X POST "https://api.oxagen.sh/v1/{org_slug}/{workspace_slug}/agent/memory/promote" \
  -H "Authorization: Bearer $OXAGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"memoryId": "mem_01H…", "toClass": "RULE", "enforcementScore": 80}'
```

API — promote to FACT with a rationale and supporting evidence:

```bash
curl -X POST "https://api.oxagen.sh/v1/{org_slug}/{workspace_slug}/agent/memory/promote" \
  -H "Authorization: Bearer $OXAGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"memoryId": "mem_01H…", "toClass": "FACT", "rationale": "confirmed by finance", "basedOnEvidenceIds": ["ev_01H…"]}'
```

CLI (rationale flag now optional):

```bash
oxagen memory promote mem_01H… --to rule --enforcement 80
oxagen memory promote mem_01H… --to fact --rationale "confirmed by finance"
```

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §4
