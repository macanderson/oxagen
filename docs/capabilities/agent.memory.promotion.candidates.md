# agent.memory.promotion.candidates

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Return the top OBSERVATION memories by citation pressure that are ripe to promote
to RULE/FACT. Backs the "promote me" UI that always surfaces the highest-signal
2–3 memories. See `docs/specs/two-axis-memory/DESIGN.md` §7c.

## Input

| Field   | Type              | Notes                          |
| ------- | ----------------- | ------------------------------ |
| `limit` | `int` ≤ 25 (def 3) | How many candidates to return. |

## Output

`candidates[]`: `{ id, publicId, lesson, memoryKind, citationCount, influenceCount, confidenceScore }`,
ordered by `citationCount` then `influenceCount` (descending).

## Side effects

None — read-only.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §7c
