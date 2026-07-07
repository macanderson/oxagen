# agent.subagent.fanout.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

List subagent fan-outs for the active workspace with their status and child-run counts, so a user can watch what the in-app agent dispatched. Optionally filter by the parent message that triggered the fan-out. Pairs with `agent.subagent.fanout.get` for per-fanout child-run detail.

## Input

| Field | Type | Notes |
|---|---|---|
| `parentMessageId?` | `string` | Restrict results to fan-outs triggered by this message. |
| `limit` | `number` (int, 1–100) | Maximum number of fan-outs to return, newest first. Default `50`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `fanouts` | `FanoutSummary[]` | The workspace's fan-outs — see fields below. |
| `fanouts[].fanoutId` | `string` | Public id — pass to `agent.subagent.fanout.get`. |
| `fanouts[].parentMessageId` | `string` | Message that triggered the fan-out. |
| `fanouts[].status` | `"pending" \| "running" \| "completed" \| "partial" \| "timed_out"` | Aggregate status. |
| `fanouts[].totalChildren` | `number` (int) | Number of child runs dispatched. |
| `fanouts[].completedChildren` | `number` (int) | Number of children finished. |
| `fanouts[].createdAt` | `string` | ISO timestamp the fan-out was created. |
| `fanouts[].updatedAt` | `string` | ISO timestamp of the last status change. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- None — read-only. Postgres SELECT of workspace fan-out aggregate rows.

## Errors

| code | meaning |
|---|---|
| `validation_error` | Input failed Zod parse (e.g. `limit` out of range). |
| `unauthorized` | Caller lacks the required org/workspace role. |
