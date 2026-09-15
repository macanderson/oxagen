# run.list

The runs table on the Fleet page (`apps/app/ARCHITECTURE.md` §1.2). One list over the two stores that record runs: the evidence ledger (`agent.agent_runs`, public id `arun_…`) for runs an external engine submits evidence for, and `tacho.sessions` (public id `tse_…`) for wrapped agents. Root sessions only; a subagent chain is part of its parent's run. Newest first, keyset-paged on an opaque cursor.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs`
- MCP: `list_runs`
- Authentication: session (org Owner, Admin, or Member; workspace Owner or Member)
- Capability name: `list_runs`
- Not billed (`noBillingGate: true`): a console read is never a governed action (ADR-052 exclusion 2), so a page load stays off the GAU meter and reachable at `remaining = 0`. IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `limit` | integer | no | 1-100, default 50 |
| `cursor` | string | no | the `nextCursor` of an earlier page; a cursor this capability did not write is `invalid_input` |

## Output

| Field | Type | Description |
|---|---|---|
| `runs` | object[] | see the row below |
| `nextCursor` | string or null | null on the last page |

Each row:

| Field | Type | Description |
|---|---|---|
| `id` | string | `arun_…` or `tse_…` |
| `source` | enum | `ledger`, `tacho` — Halt and frames depend on it |
| `agentKey` | string or null | `org_ns.ws_ns.slug`; null when the ledger row names no agent |
| `operatorId` | string or null | the initiating principal's public id; null when none was recorded |
| `status` | enum | `live`, `sealed`, `halted` |
| `turns` | integer or null | null for a ledger run whose model-call payloads are encrypted |
| `steps` | integer | model calls plus tool calls |
| `frames` | integer | recorded events (ledger) or hash-chained events (tacho) |
| `cost` | object or null | `{ micros, currency, basis }` from the run's `cost.run_totals` row (ADR-060); `basis` is `gateway_observed`, `client_attested`, `mixed` or `estimated`; null until the rollup has priced the run's frames after its seal |
| `taskRef` | string or null | the goal a ledger run was admitted for |
| `startedAt` | string | RFC 3339 |
| `sealedAt` | string or null | null while live |
| `replayGrade` | `inspect` \| `view` \| `fork` \| `retry` or null | the grade the seal recorded (spec §8.4), null while live, on a seal the recorder never graded, or on a broken row; never computed on read, and a caller renders the recorded word and nothing stronger |
| `name` | string or null | the generated name (`summarize_run`), null until written |
| `summary` | `{ text, generatedAt, model }` or null | the generated summary with the model that wrote it and the instant; labelled generated wherever it renders |

## Honesty

A null is what a caller renders as "not recorded". Cost comes from the run's `cost.run_totals` row, which the rollup job rebuilds from the run's frames after its seal; a run with no row yet, or a row whose frames priced nothing, answers `cost: null`, never `0`, and nothing here reads ClickHouse or the tacho session's own `total_cost_micros`. Every query names `org_id` and `workspace_id` in addition to RLS, so a run from another workspace stays out of the list on a stack that runs with the RLS bypass on.
