# skill.metrics.read

**Domain:** skill
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low
**Billing gate:** none (noBillingGate = true)

## Intent

Read aggregated skill usage and cost metrics for the workspace. Returns load counts, last-used timestamps, approximate token cost (best-effort via join to token_usage on execution_step_id — multi-skill attribution is partial), and per-version load breakdown. Omit `skillId` for workspace-wide aggregation.

## Data sources

1. **Postgres `agent.skills`** — fast-path denormalized columns: `usage_count`, `last_used_at`, `active_version_id`. These are cheap to read and always available.
2. **ClickHouse `skill_loads`** — per-version load counts and last-used timestamps, aggregated by `readSkillMetrics` from `@oxagen/telemetry`. Queried best-effort: if ClickHouse is unavailable, `perVersionLoads` is empty but the rest of the response is still returned.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| skillId | string? | Public ID of a specific skill (`skl_…`). Omit for workspace-wide aggregation. |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| skills | array | One entry per matching skill |

Each skill object:

| Field | Type | Notes |
| --- | --- | --- |
| skillId | string | Public ID (`skl_…`) |
| slug | string | Kebab-case identifier |
| activeVersion | number \| null | Currently active version number (null if none set) |
| usageCount | number | Total invocations from Postgres denormalized column |
| lastUsedAt | string \| null | ISO-8601 timestamp of last recorded load (Postgres); null if never used |
| approxTokenCost | number \| null | Approximate total token cost in USD cents. **Best-effort** — multi-skill agent runs attribute cost to all loaded skills so sums may exceed actual spend. Currently returns `null` (OXA-1750 phase 2 will wire the ClickHouse token_usage join). |
| perVersionLoads | array | Per-version breakdown from ClickHouse (empty if ClickHouse unavailable) |

Each `perVersionLoads` entry:

| Field | Type | Notes |
| --- | --- | --- |
| version | number | Version number |
| loads | number | Load count for this version |
| lastUsed | string \| null | ISO-8601 timestamp of last load for this version |

## Multi-skill attribution caveat

When an agent run loads multiple skills in the same execution step, the `approxTokenCost` for each would count the full step's token usage. The sum across all skills in a workspace therefore exceeds actual spend. This is documented and expected — treat it as an upper bound, not an exact figure.

## Side effects

Read-only. No writes.

## Errors

- ClickHouse unavailable: `perVersionLoads` is empty; other fields are still populated (degraded but not failed).
- Skill not in workspace: empty `skills` array (not an error).
- DB errors propagated as-is.
