# agent.code.execute

**Domain:** agent
**Mode:** async
**Scope:** tenant + workspace
**Surfaces:** agent
**Risk level:** high (requires approval)

## Intent

Run a snippet of Node, Python, or shell in a Docker-isolated sandbox
per the §3.2 sandbox contract. Output streams back as tool-call output
on the chat stream; the container is torn down on completion, timeout,
or memory cap.

## Input

| Field       | Type                          | Notes                                                            |
| ----------- | ----------------------------- | ---------------------------------------------------------------- |
| `language`  | `"node" \| "python" \| "shell"` | Selects the pinned image from `packages/sandbox/images.ts`.    |
| `code`      | `string`                      | 1 to 100000 chars.                                               |
| `stdin`     | `string?`                     | Optional stdin payload.                                          |
| `env`       | `Record<string,string>?`      | Extra env vars. Subject to workspace policy.                     |
| `timeoutMs` | `number`                      | Wallclock cap. Defaults 30000; cap 300000.                       |
| `memoryMb`  | `number`                      | Container memory cap. Defaults 512; cap 2048.                    |
| `network`   | `"allow" \| "deny"`           | Egress policy; default `deny`. Workspace may forbid `allow`.     |

## Output

| Field        | Type      | Notes                                          |
| ------------ | --------- | ---------------------------------------------- |
| `exitCode`   | `number`  | Process exit code; -1 on container failure.    |
| `stdout`     | `string`  | Captured stdout, truncated at policy limit.    |
| `stderr`     | `string`  | Captured stderr, truncated at policy limit.    |
| `durationMs` | `number`  | Wallclock duration in ms.                      |
| `timedOut`   | `boolean` | True if the wallclock cap fired.               |
| `oomKilled`  | `boolean` | True if the OOM killer fired.                  |

## Side effects

- Docker: spawn one short-lived container per invocation; tear it down on completion.
- ClickHouse: emit `agent.code.executed` rows with truncated output and metadata.
- Postgres: insert an `execution.tool_calls` row tied to the parent chat message.

## Errors

| code              | meaning                                          |
| ----------------- | ------------------------------------------------ |
| `language_disallowed` | Workspace policy disables this language.     |
| `network_disallowed`  | Workspace policy disables `network: allow`. |
| `sandbox_unavailable` | Docker daemon unreachable.                  |

## SPEC references

- §3.2 — Docker code sandbox
- §4 — new capabilities
