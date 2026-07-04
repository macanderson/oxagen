# agent.subagent.fanout.get

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Get one subagent fan-out together with its child runs. Each child reports its capability, live status, timings, error reason, and the serialized size plus a bounded preview of its input/output payloads. Polled by the in-app viewer for live status.

## Input

| Field | Type | Notes |
|---|---|---|
| `fanoutId` | `string` | Public id of the fan-out to fetch. |

## Output

| Field | Type | Notes |
|---|---|---|
| `fanoutId` | `string` | Echoes the fan-out id. |
| `parentMessageId` | `string` | Message that triggered the fan-out. |
| `status` | `"pending" \| "running" \| "completed" \| "partial" \| "timed_out"` | Aggregate fan-out status. |
| `totalChildren` | `number` (int) | Number of child runs dispatched. |
| `completedChildren` | `number` (int) | Number of children finished. |
| `createdAt` | `string` | ISO timestamp the fan-out was created. |
| `updatedAt` | `string` | ISO timestamp of the last status change. |
| `runs` | `ChildRun[]` | Per-child detail — see fields below. |
| `runs[].runId` | `string` | Child run id. |
| `runs[].capabilityName` | `string` | Capability the child invoked. |
| `runs[].status` | `"pending" \| "running" \| "completed" \| "failed"` | Child run status. |
| `runs[].errorReason` | `string \| null` | Failure reason, or null. |
| `runs[].startedAt` | `string \| null` | ISO start timestamp, or null. |
| `runs[].completedAt` | `string \| null` | ISO completion timestamp, or null. |
| `runs[].durationMs` | `number \| null` (int) | Wall-clock duration once the run has completed. |
| `runs[].inputBytes` | `number` (int) | Serialized size of the input payload. |
| `runs[].outputBytes` | `number` (int) | Serialized size of the output payload, 0 when none. |
| `runs[].outputPreview` | `string \| null` | Truncated JSON preview of the output, or null when none. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- None — read-only. Postgres SELECT of the fan-out aggregate and its child-run rows.

## Errors

| code | meaning |
|---|---|
| `not_found` | No fan-out matches `fanoutId` in this workspace. |
| `validation_error` | Input failed Zod parse. |
| `unauthorized` | Caller lacks the required org/workspace role. |
