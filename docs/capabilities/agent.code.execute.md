# agent.code.execute

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high
**Requires approval:** yes (riskLevel: high)

## Intent

Execute a code snippet in an isolated sandbox and return the exit code,
stdout, stderr, and execution time. Supports Node.js, Python 3, and shell
scripts. Sandbox availability is gated by `SANDBOX_ENABLED=true` and a
configured driver (`SANDBOX_DRIVER`: `vercel` | `modal` | `docker`).

## Input

| Field       | Type                            | Default    | Notes                                                       |
| ----------- | ------------------------------- | ---------- | ----------------------------------------------------------- |
| `language`  | `"node" \| "python" \| "shell"` | required   | Runtime language for the sandbox                           |
| `code`      | `string`                        | required   | Source code to execute (min 1 char)                        |
| `stdin`     | `string?`                       | undefined  | Optional stdin; not supported on the Vercel driver         |
| `env`       | `Record<string, string>?`       | undefined  | Environment variables injected into the sandbox            |
| `timeoutMs` | `integer`                       | `30000`    | Execution timeout in ms (1 000–300 000)                    |
| `memoryMb`  | `integer`                       | `256`      | Memory limit in MiB (64–2048)                              |
| `network`   | `"allow" \| "deny"`             | `"deny"`   | Network access policy                                       |

## Output

| Field         | Type      | Notes                                                                |
| ------------- | --------- | -------------------------------------------------------------------- |
| `exitCode`    | `integer` | Process exit code (0 = success)                                      |
| `stdout`      | `string`  | Captured standard output (truncated at 8 MB)                        |
| `stderr`      | `string`  | Captured standard error (truncated at 8 MB)                         |
| `executionMs` | `integer` | Wall-clock time in milliseconds for the execution                    |
| `timedOut`    | `boolean` | True when execution exceeded `timeoutMs`                             |
| `oomKilled`   | `boolean` | True when the sandbox process was killed due to memory limit         |

## Side effects

None — the sandbox is ephemeral and torn down after each run.

## API

```
POST /v1/{org}/{workspace}/agent/code/execute
Content-Type: application/json

{
  "language": "python",
  "code": "print('hello')",
  "timeoutMs": 10000,
  "network": "deny"
}
```

## MCP

Tool name: `agent.code.execute`

## Errors

- Throws if `SANDBOX_ENABLED` is not `true` or the driver is not configured.
- Throws `VercelSandboxUnsupportedError` if `stdin` is supplied to the Vercel driver.
- Non-zero exit codes do **not** throw — they are surfaced in `exitCode`.
