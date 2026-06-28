# agent.sandbox.start

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** high
**Requires approval:** yes (riskLevel: high)

## Intent

Provision or reconnect to a **durable** code-agent sandbox that persists
filesystem and process state across multiple agent turns. Unlike the one-shot
`agent.code.execute`, a durable sandbox survives between calls — the agent can
clone a repository in one exec, install dependencies in a second, build a
feature in a third, and open a PR, all without losing the working tree.

**Session reuse:** pass a stable `sessionKey` (e.g. the conversation or
agent-run id) and repeated `agent.sandbox.start` calls return the same warm
sandbox (`reused: true`). If the backing sandbox was reaped while idle but a
filesystem snapshot exists, it is restored transparently. Omit `sessionKey` to
always provision a fresh session.

## Input

| Field                | Type                                          | Default   | Notes                                                                                                                                  |
| -------------------- | --------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `image`              | `"node" \| "python" \| "shell" \| "agent"`    | `"agent"` | Base image. `"agent"` = Debian + git + curl (default for repo workflows); others are language bases, all with git pre-installed.      |
| `sessionKey`         | `string?`                                     | undefined | Stable key to reuse a warm (or snapshot-restored) sandbox across turns. Omit to always create a fresh session.                        |
| `memoryMb`           | `integer`                                     | `2048`    | Memory limit in MiB (256–8192). Durable build sandboxes default higher than the one-shot executor.                                    |
| `ttlSeconds`         | `integer`                                     | `86400`   | Hard ceiling on total session lifetime in seconds (300–86400, max 24h).                                                               |
| `idleTimeoutSeconds` | `integer`                                     | `1200`    | Reap the sandbox after this many seconds of inactivity (60–86400). Primary cost control — a reaped session restores from its last snapshot on next exec. |
| `network`            | `"allow" \| "deny"`                           | `"allow"` | Network policy. Durable build sandboxes default to `"allow"` so they can clone repos and install dependencies.                        |
| `setupCmd`           | `string?`                                     | undefined | Optional shell command run once at create time (e.g. `git clone … && pnpm i`). Skipped on warm reuse.                                |

## Output

| Field       | Type                                         | Notes                                                                     |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `sessionId` | `string`                                     | Opaque durable-session id (`sbx_…`); pass to `agent.sandbox.exec`.       |
| `status`    | `string`                                     | Current session status (e.g. `"running"`, `"starting"`).                 |
| `image`     | `"node" \| "python" \| "shell" \| "agent"`  | Base image in use.                                                        |
| `createdAt` | `string`                                     | ISO 8601 creation timestamp.                                              |
| `reused`    | `boolean`                                    | `true` when an existing warm or snapshot-restored session was returned.   |

## Side effects

- Provisions a long-lived container on the configured sandbox driver (Modal).
- Charges against the org's sandbox compute budget while the session is alive.
- Runs `setupCmd` once at create time when a fresh session is provisioned.

## API

```
POST /v1/{org}/{workspace}/agent/sandbox/start
Content-Type: application/json

{
  "image": "agent",
  "sessionKey": "conv_abc123",
  "memoryMb": 4096,
  "network": "allow",
  "setupCmd": "git clone https://github.com/example/repo /workspace && cd /workspace && pnpm i"
}
```

Response:

```json
{
  "sessionId": "sbx_01abc...",
  "status": "running",
  "image": "agent",
  "createdAt": "2026-06-28T12:00:00Z",
  "reused": false
}
```

## MCP

Tool name: `agent.sandbox.start`

## Notes

- Requires `SANDBOX_ENABLED=true` and a session-capable driver (`SANDBOX_DRIVER=modal`).
- The `idleTimeoutSeconds` is the primary cost control — set it tightly for
  short-lived workflows and loosely for multi-hour builds.
- Pair with `agent.sandbox.snapshot` at meaningful milestones (repo cloned,
  deps installed) so idle reaps do not lose work.
- Explicit `agent.sandbox.stop` when done is preferred over relying on idle reap.
