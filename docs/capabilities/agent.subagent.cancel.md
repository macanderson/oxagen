# agent.subagent.cancel

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Cancel an in-progress subagent fan-out. Transitions the fanout record and every
non-terminal child run to a terminal status so the Inngest worker performs no
further work. Returns a summary so the caller can confirm the cancellation
without a follow-up poll. This is the missing CRUD leg for the fan-out lifecycle
(create via `agent.subagent.dispatch`, read via `agent.subagent.fanout.get`).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| fanoutId | string | Public ID of the fan-out to cancel |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| fanoutId | string | The fan-out that was cancelled |
| status | string | Terminal status the fanout was transitioned to |
| cancelledChildren | number | Count of child runs transitioned to a terminal status |

## Side effects

Updates the `subagent_fanouts` row and its non-terminal `subagent_runs` rows in
Postgres, scoped by `orgId` + `workspaceId` + `fanoutId`. Emits an
`agent.subagent.cancel.ran` event to ClickHouse (best-effort metering). The call
is idempotent: a fan-out already in a terminal state is left unchanged.

> **Note:** the `subagent_fanouts` / `subagent_runs` CHECK constraints do not yet
> include a `cancelled` value, so cancel uses the closest available terminal
> statuses (`timed_out` for the fanout, `failed` for runs). A follow-up migration
> adding `cancelled` will let this report the cancellation distinctly.

## Errors

- Throws when the fan-out does not exist (or is not visible to the caller's
  org + workspace).
