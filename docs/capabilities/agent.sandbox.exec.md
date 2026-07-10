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

**Stateful working directory:** each exec is a *fresh* `sh -c` — the shell's
`cwd` would otherwise reset to the image default every call, so a `cd` in one
command would be invisible to the next. To keep a stateful shell (e.g. an
interactive terminal), pass the `cwd` returned by the previous call back in as
the next call's `cwd`. The runner `cd`s there before running and reports the
resulting directory in `cwd`. Filesystem/process state is always shared; only
the *shell* cwd needs this explicit threading.

## Input

| Field       | Type                        | Default    | Notes                                                                                                                           |
| ----------- | --------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId` | `string`                    | required   | Durable-session id (`sbx_…`) returned by `agent.sandbox.start`.                                                                |
| `command`   | `string`                    | required   | Shell command line, executed via `sh -c` in the session workspace (max 100 000 chars).                                         |
| `cwd`       | `string?`                   | undefined  | Working directory to run the command in (max 4 096 chars). Pass the previous call's returned `cwd` to make `cd` persist across commands. Omit for the image default. |
| `timeoutMs` | `integer`                   | `120000`   | Execution timeout in milliseconds (1 000–600 000, i.e. 1s–10min).                                                             |
| `env`       | `Record<string, string>?`   | undefined  | Per-command env vars. Reserved sandbox/host names and prefixes (`PATH`, `LD_*`, `MODAL_*`, `DATABASE_*`, …) are stripped; capped at 32 keys / 8KB. |
| `stdin`     | `string?`                   | undefined  | Optional stdin input piped to the command.                                                                                      |

## Output

| Field         | Type              | Notes                                                                        |
| ------------- | ----------------- | ---------------------------------------------------------------------------- |
| `exitCode`    | `integer`         | Process exit code (0 = success).                                             |
| `stdout`      | `string`          | Captured standard output.                                                    |
| `stderr`      | `string`          | Captured standard error.                                                     |
| `executionMs` | `integer`         | Wall-clock execution time in milliseconds.                                   |
| `timedOut`    | `boolean`         | `true` when execution exceeded `timeoutMs`.                                  |
| `restored`    | `boolean`         | `true` when the session had been reaped and was restored from a snapshot before running. |
| `cwd`         | `string \| null`  | The shell's working directory after the command ran; thread it into the next call's `cwd`. `null` when it couldn't be captured (command self-`exit`ed, timed out, or a runner deployed before cwd support). |

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
  "command": "pnpm build",
  "cwd": "/workspace",
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
  "restored": false,
  "cwd": "/workspace"
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
