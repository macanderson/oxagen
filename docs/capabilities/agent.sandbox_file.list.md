# agent.sandbox.files.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Billing:** not gated (a read-only listing consumes no AI tokens)

## Intent

List files and directories inside a durable sandbox session's workspace (a
session created by `agent.sandbox.start`), so the web workspace-context panel,
and MCP callers can render a file tree without a manual
`agent.sandbox.exec("ls -R")` round-trip.

## Driver normalization

Rather than adding a per-driver "list files" method (docker/modal/vercel would
each report differently), the handler runs **one portable `find` command**
through the same `execInSession` primitive `agent.sandbox.exec` uses, with a
fixed `%y\t%s\t%p` output format. The result is therefore identical on whichever
driver is active. Only the Modal driver implements durable sessions today; the
rest fail closed via `requireDurableDriver()`, exactly like every other
`agent.sandbox.*` capability. A reaped sandbox is restored from its last
snapshot and the listing retried once (same recovery contract as
`agent.sandbox.exec`).

## Input

| Field       | Type                          | Notes                                                                                  |
| ----------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `sessionId` | `string`                      | Durable-session id (`sbx_…`) returned by `agent.sandbox.start`.                         |
| `path`      | `string` (optional)           | Workspace-relative directory to list (e.g. `src`). Defaults to the workspace root. Must not be absolute or contain `..` segments (validated against `@oxagen/sandbox/workspace`). |
| `depth`     | `number` (1–5, default 2)     | Maximum recursion depth below the listed directory.                                    |

## Output

| Field     | Type                                                    | Notes                                                        |
| --------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| `entries` | `Array<{ path, kind, sizeBytes }>`                      | Sorted by path. `path` is workspace-relative; `kind` is `"file"` or `"dir"`; `sizeBytes` is a non-negative integer (0 for dirs / unknown). Symlinks and other special files are omitted. |

## Surfaces

- **API:** `POST /v1/:org/:workspace/agent/sandbox/files` — body `{ sessionId, path?, depth? }`
- **MCP:** `agent.sandbox.files.list` tool (read-only, idempotent)
- **Agent:** invoked via `invoke("agent.sandbox_file.list", ...)` — no approval required

## Access control

- Caller must be an authenticated workspace member.
- The session must belong to the caller's workspace and be running (a stopped or
  gone session throws `sandbox_session_not_found`).
- Default effect: **deny** — explicit role grant required (Org Owner/Admin,
  Workspace Owner/Member allowed by default).

## Side effects

- Runs a bounded `find` command inside the durable sandbox via `execInSession`.
- Postgres: bumps the session's `last_used_at` (and rebinds the sandbox id on a
  snapshot restore). No other writes.

## Errors

| code                          | meaning                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `durable_sandbox_unavailable` | No session-capable sandbox driver is configured.               |
| `sandbox_session_not_found`   | Session unknown, stopped, or out of the caller's workspace.    |
| `sandbox_session_gone`        | Session was reaped and has no snapshot to restore from.        |
| `validation_error`            | Input failed Zod parse (unsafe path, depth out of range, …).   |
