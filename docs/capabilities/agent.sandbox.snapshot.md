# agent.sandbox.snapshot

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Capture a **filesystem snapshot** of a durable sandbox session so its state
can be restored after an idle reap or the 24h hard lifetime ceiling. Snapshots
let a long-running build workflow survive across agent turns without re-cloning
or re-installing from scratch.

Recommended milestones to snapshot:
- After `git clone` completes.
- After `pnpm install` / `pip install` completes.
- After a partial build phase produces intermediate artifacts.
- Just before submitting a PR (so the exact state is recoverable).

The next `agent.sandbox.exec` on a reaped session automatically restores from
the most recent snapshot (`restored: true`) without any caller action.

**Constraint:** the session must be idle (no command mid-flight) when snapshotting.

## Input

| Field       | Type     | Default  | Notes                                                     |
| ----------- | -------- | -------- | --------------------------------------------------------- |
| `sessionId` | `string` | required | Durable-session id (`sbx_…`) returned by `agent.sandbox.start`. |

## Output

| Field        | Type     | Notes                                                                            |
| ------------ | -------- | -------------------------------------------------------------------------------- |
| `snapshotId` | `string` | Filesystem snapshot id recorded on the session for transparent restore on next exec. |

## Side effects

- Persists a point-in-time filesystem image in the sandbox driver's snapshot store.
- The snapshot is associated with the session and used automatically on restore.
- Repeated snapshots overwrite the session's restore pointer with the latest image.

## API

```
POST /v1/{org}/{workspace}/agent/sandbox/snapshot
Content-Type: application/json

{
  "sessionId": "sbx_01abc..."
}
```

Response:

```json
{
  "snapshotId": "snap_01xyz..."
}
```

## MCP

Tool name: `agent.sandbox.snapshot`

## Notes

- Do not call while a command is executing in the session — wait for the exec to
  complete first.
- Snapshots only capture the filesystem; in-memory process state (e.g. a running
  dev server) is not preserved and must be re-started after a restore.
- Snapshots are stored by the sandbox driver (Modal) and billed at driver rates.
