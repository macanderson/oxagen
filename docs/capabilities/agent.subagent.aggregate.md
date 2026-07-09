# agent.subagent.aggregate

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Return the status, per-child summaries, conflict list, and execution timeline
for a subagent fanout. Compact by default (docs/specs/graph-mediated-fanout):
each child carries a ≤280-char structural summary plus its `runId` — full
payloads are fetched per-run via `agent.subagent.result.get`, never relayed
wholesale into the caller's context. Non-blocking snapshot; durable waiting is
handled by the `agent.aggregate-fanout` Inngest function.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| fanoutId | string | Public ID of the subagent fanout to aggregate |
| timeoutMs | number | Snapshot staleness window in ms (default 5 min, max 30 min); non-blocking, never sleeps |
| includeOutputs | boolean | DEPRECATED legacy mode: attach each child's full input + output (outputs capped at 8 KB serialized, `outputTruncated` when clipped). Default false |
| includeMerged | boolean | Include `aggregatedData` (deep-merge of successful outputs, capped at 16 KB serialized). Default false; `conflicts` is always returned |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| fanoutId | string | Fanout ID from input |
| status | enum | "pending", "running", "completed", "partial", "failed", "timed_out" |
| totalChildren | number | Total number of child runs in the fanout |
| completedChildren | number | Live count of children that completed successfully |
| aggregatedData | object? | Merged output of successful runs — null unless `includeMerged` (and null while running / over the cap) |
| aggregatedDataTruncated | boolean | True when the requested merge exceeded the 16 KB cap |
| conflicts | array of objects | Keys where two or more runs produced different values |
| timeline | array of objects | Live per-child status/timing — always populated |
| children | array of objects | Compact per-child results: `runId`, `capabilityName`, `status`, `summary` (≤280 chars), `outputBytes`, `errorReason`. Empty while running (compact mode). With `includeOutputs` also `input`/`output`/`outputTruncated` |
| recheckAfterMs | number? | Suggested wait before the next call — non-null only while running; respect it instead of tight-polling |
| firstError | string? | Error reason from the first failed child, or null |

## Side effects

Reads from Postgres. No mutations. ClickHouse telemetry events recorded for
aggregation.

## Errors

- `FanoutNotFoundError` — unknown or cross-tenant fanoutId; surfaces map it to 404.
