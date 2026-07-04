# agent.subagent.siblings

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Given a running fanout child's `runId`, return that child's **siblings** — the
other runs in the same fanout — as compact rows (`capabilityName`, `status`,
`summary`, `attempts`), never their full payloads. Tier A of Phase 2
graph-mediated fanout (docs/specs/graph-mediated-fanout-phase2 §3): a running
child calls this to check "has a sibling already covered X?" before burning
tokens. A sibling's full output is one `agent.subagent.result.get` away — the
same compact-by-default steering rule as `agent.subagent.aggregate`.

One indexed Postgres query over the caller's fanout; no graph round-trip on the
hot path.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| runId | string | Public ID of the calling child run (`sar_…`) whose siblings to list |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| runId | string | The calling run's public ID, echoed back |
| fanoutId | string | Public ID of the fanout these runs belong to |
| siblings | array | Fanout siblings **excluding the calling run** — compact rows |

Each `siblings[]` entry:

| Field | Type | Notes |
| --- | --- | --- |
| runId | string | Sibling run's public ID (`sar_…`) — fetch its full payload via `agent.subagent.result.get` |
| capabilityName | string | Capability the sibling executed |
| status | enum | "pending", "running", "completed", "failed" |
| summary | string? | The sibling's compact structural digest, when recorded |
| attempts | number | How many times the sibling has been attempted/leased |
| errorReason | string? | Failure reason, or null |

## Side effects

Reads from Postgres. No mutations. No graph round-trip.

## Errors

- `SubagentRunNotFoundError` — unknown or cross-tenant `runId`; surfaces map it to 404.
