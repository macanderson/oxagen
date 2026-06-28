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

## Side effects

- Terminates the sandbox container and stops compute billing immediately.
- Marks the session `stopped` in the durable session registry.
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

- Idempotent: stopping an already-stopped session returns `{ stopped: true }`
  without error.
- If a command is currently executing in the session, stop sends a termination
  signal; the running command may receive a non-zero exit code.
- Always call stop at the end of an agent workflow that opened a PR — leaving
  durable sandboxes running is the primary source of unexpected compute cost.
