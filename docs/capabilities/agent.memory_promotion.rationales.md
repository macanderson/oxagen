# agent.memory.promotion.rationales

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Draft candidate rationales for a promotion (or demotion) so a reviewer can pick
one instead of typing. Loads the memory's lesson, kind, class, and
citation/evidence signals and asks a low-cost model (via `@oxagen/ai`, metered)
for short, context-grounded reasons. The rationale itself stays optional on
promote/demote — this only removes the typing friction. See
`docs/specs/two-axis-memory/DESIGN.md` §7c.

## Input

| Field      | Type                                | Notes                                             |
| ---------- | ----------------------------------- | ------------------------------------------------- |
| `memoryId` | `string`                            | The AgentMemory node id being promoted/demoted.   |
| `toClass`  | `"RULE" \| "FACT" \| "OBSERVATION"` | The class change being considered.                |
| `count`    | `int 2–6`                           | How many candidate rationales to draft. Default 4. |

## Output

| Field        | Type              | Notes                                       |
| ------------ | ----------------- | ------------------------------------------- |
| `rationales` | `string[]` (1–6)  | Candidate rationales, most fitting first.   |

## Behavior

- Model tier: **fast/cheap** (drafting short sentences needs no reasoning model), metered through `@oxagen/ai`.
- Graceful degradation: if the model call fails or returns nothing usable, the handler falls back to deterministic template rationales built from the memory's citation counts, so the capability never errors on a transient gateway failure.
- Output is clamped: each rationale ≤ 200 chars, deduped, capped to `count`.

## Side effects

- None (read-only aside from metering emitted by `@oxagen/ai`).

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §7c
