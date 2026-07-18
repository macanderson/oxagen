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

## Configuration

- `count` (2–6, default 4) controls how many options are drafted — the app's
  rationale picker requests the default; raise it for denser review queues.
- The model is resolved through `modelIdOf()` on the fast/cheap tier — there is
  no per-workspace model override for this capability; it inherits the
  workspace's BYOK gateway configuration like every `@oxagen/ai` call, and the
  call is metered to ClickHouse (`capability_name = suggest_promotion_rationales`).

## Examples

API — draft rationales for promoting an observation to a rule:

```bash
curl -X POST "https://api.oxagen.sh/v1/{org_slug}/{workspace_slug}/agent/memory/promotion/rationales" \
  -H "Authorization: Bearer $OXAGEN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"memoryId": "mem_01H…", "toClass": "RULE", "count": 4}'
```

Response shape:

```json
{
  "rationales": [
    "Cited in 12 executions with 5 decisive influences — consistently load-bearing.",
    "Repeated independently across three connectors; no contradicting evidence.",
    "Team-confirmed during review on the linked execution.",
    "High citation pressure and stable confidence over 30 days."
  ]
}
```

MCP — tool `suggest_promotion_rationales` (same input). Also valid for demotions
(`toClass: "OBSERVATION"`), where the drafts explain why the memory should step
down.

App: the rationale select in every promote/demote flow on Knowledge → Memory is
backed by this capability; "Write my own…" bypasses it.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md` §7c
