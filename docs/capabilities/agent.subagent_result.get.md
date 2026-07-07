# agent.subagent.result.get

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Fetch ONE subagent child run's full input + output payloads by `runId`. The
scoped on-demand counterpart to the compact-by-default
`agent.subagent.aggregate` (docs/specs/graph-mediated-fanout): aggregate
returns ≤280-char summaries + runId refs; call this only for the specific
child whose summary is insufficient — do not fetch every child.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| runId | string | Public ID of the child run (`sar_…`, from aggregate `children[].runId` / `timeline[].runId`) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| runId | string | Run ID from input |
| fanoutId | string | Public ID of the fanout this run belongs to |
| capabilityName | string | Capability the child executed |
| status | enum | "pending", "running", "completed", "failed" |
| summary | string? | The structural digest aggregate returned, when recorded |
| input | unknown | Full input payload the child was dispatched with |
| output | unknown | Full output payload; null until the run completes |
| errorReason | string? | Failure reason, or null |
| startedAt | string? | ISO timestamp, null until the run starts |
| completedAt | string? | ISO timestamp, null until terminal |

## Side effects

Reads from Postgres. No mutations.

## Errors

- `SubagentRunNotFoundError` — unknown or cross-tenant runId; surfaces map it to 404.
