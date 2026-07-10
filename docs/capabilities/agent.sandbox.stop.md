# agent.sandbox.stop

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Terminate a durable sandbox session and release its container resources. Call
this when the agent's work is complete (PR opened, review requested) to stop
billing for the running container. Idle reaping (governed by
`idleTimeoutSeconds` on `agent.sandbox.start`) is the safety-net cost control,
but explicit stop is the clean and preferred path.

Stopping a session marks its registry row `stopped`; subsequent
`agent.sandbox.exec` calls against the same `sessionId` will error. To
continue work later, provision a new session (with the same `sessionKey` if a
snapshot exists — `agent.sandbox.start` will restore from it).

## Input

| Field       | Type     | Default  | Notes                                                          |
| ----------- | -------- | -------- | -------------------------------------------------------------- |
| `sessionId` | `string` | required | Durable-session id (`sbx_…`) returned by `agent.sandbox.start`. |

## Output

| Field     | Type      | Notes                              |
| --------- | --------- | ---------------------------------- |
| `stopped` | `boolean` | `true` when the session was successfully terminated and its registry row updated. |

## Retirement model

Stop is designed so the registry row — the thing Oxagen owns — is **always**
retired, and the capability never throws for a retirable session:

1. The session row is read first (including an already soft-deleted one). An
   already-`stopped` session returns `{ stopped: true }` idempotently with no
   provider call; an unknown session id is a not-found error.
2. The driver is resolved from the **session's own `driver` column**
   (vendor-neutral — a session created on one provider is torn down on that same
   provider), not the deployment default. The provider `stopSession` call is
   strictly best-effort: an already-dead sandbox, an unreachable provider, or a
   deployment with no durable driver configured all still let the row be retired
   (the failure is logged, not surfaced).
3. The row is marked `stopped` (soft-deleted) unconditionally.

## Side effects

- Sends a best-effort terminate to the sandbox container so compute billing stops.
- Marks the session `stopped` (soft-deleted) in the durable session registry —
  always, even when the provider call fails.
- Does **not** delete filesystem snapshots — previously snapshotted state
  remains available for restore via a future `agent.sandbox.start` with the
  same `sessionKey`.

## API

```
POST /v1/{org}/{workspace}/agent/sandbox/stop
Content-Type: application/json

{
  "sessionId": "sbx_01abc..."
}
```

Response:

```json
{
  "stopped": true
}
```

## MCP

Tool name: `agent.sandbox.stop`

## Notes

- Idempotent: stopping an already-stopped (or soft-deleted) session returns
  `{ stopped: true }` without error and without a provider call.
- Never throws for a retirable session — a missing/unconfigured durable driver
  retires the registry row anyway (see **Retirement model**).
- The reaper's flush path calls this same handler best-effort, then writes the
  terminal state itself, so a reaped sandbox never lingers as idle/running.
- If a command is currently executing in the session, stop sends a termination
  signal; the running command may receive a non-zero exit code.
- Always call stop at the end of an agent workflow that opened a PR — leaving
  durable sandboxes running is the primary source of unexpected compute cost.
