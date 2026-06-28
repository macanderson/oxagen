# agent.sandbox.exec

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high
**Requires approval:** yes (riskLevel: high)

## Intent

Run a shell command inside an existing durable sandbox session created by
`agent.sandbox.start`. Filesystem and process state are **shared and persistent**
across calls — a `git clone` in one exec is visible to a `pnpm build` in the
next. This is the execution counterpart to the session lifecycle managed by
`agent.sandbox.start` / `agent.sandbox.stop`.

**Transparent restore:** if the backing sandbox was reaped while idle (due to
`idleTimeoutSeconds`) but a filesystem snapshot exists, the handler restores it
from the last snapshot and retries the command transparently (`restored: true`
in the response).

## Input

| Field       | Type                        | Default    | Notes                                                                                                                           |
| ----------- | --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId` | `string`                    | required   | Durable-session id (`sbx_…`) returned by `agent.sandbox.start`.                                                                |
| `command`   | `string`                    | required   | Shell command line, executed via `sh -c` in the session workspace (max 100 000 chars).                                         |
| `timeoutMs` | `integer`                   | `120000`   | Execution timeout in milliseconds (1 000–600 000, i.e. 1s–10min).                                                             |
| `env`       | `Record<string, string>?`   | undefined  | Per-command env vars. Reserved sandbox/host names and prefixes (`PATH`, `LD_*`, `MODAL_*`, `DATABASE_*`, …) are stripped; capped at 32 keys / 8KB. |
| `stdin`     | `string?`                   | undefined  | Optional stdin input piped to the command.                                                                                      |

## Output

| Field         | Type      | Notes                                                                        |
| ------------- | --------- | ---------------------------------------------------------------------------- |
| `exitCode`    | `integer` | Process exit code (0 = success).                                             |
| `stdout`      | `string`  | Captured standard output.                                                    |
| `stderr`      | `string`  | Captured standard error.                                                     |
| `executionMs` | `integer` | Wall-clock execution time in milliseconds.                                   |
| `timedOut`    | `boolean` | `true` when execution exceeded `timeoutMs`.                                  |
| `restored`    | `boolean` | `true` when the session had been reaped and was restored from a snapshot before running. |

## Side effects

- Runs arbitrary shell code in the tenant-scoped sandbox container. Changes to
  the filesystem persist for subsequent execs within the same session.
- Non-zero exit codes do **not** throw — they are surfaced in `exitCode`.

## API

```
POST /v1/{org}/{workspace}/agent/sandbox/exec
Content-Type: application/json

{
  "sessionId": "sbx_01abc...",
  "command": "cd /workspace && pnpm build",
  "timeoutMs": 300000
}
```

Response:

```json
{
  "exitCode": 0,
  "stdout": "Build complete in 42s",
  "stderr": "",
  "executionMs": 42318,
  "timedOut": false,
  "restored": false
}
```

## MCP

Tool name: `agent.sandbox.exec`

## Notes

- The session must be in `"running"` or restorable state; call
  `agent.sandbox.start` (with the same `sessionKey`) first.
- Filesystem mutations from one exec are immediately visible in the next — the
  working tree is not snapshotted between individual execs.
- Call `agent.sandbox.snapshot` after expensive setup steps (clone, install) to
  protect work from idle reap.
