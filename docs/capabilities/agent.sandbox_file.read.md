# agent.sandbox_file.read

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Billing:** not gated (a read-only file read consumes no AI tokens)
**Alias:** `agent.sandbox.files.read` (symmetry with `agent.sandbox_file.list`'s legacy alias)

## Intent

Read one file's contents from a durable sandbox session's workspace (a session
created by `agent.sandbox.start`), so the web workspace-context panel's file
viewer and MCP callers can show what the coding agent is working on
without a manual `agent.sandbox.exec("cat …")` round-trip. The read counterpart
of `agent.sandbox_file.list`.

## Driver normalization

Mirrors `agent.sandbox_file.list`: rather than a per-driver "read file" method,
the handler runs **one portable shell one-liner** through the same
`execInSession` primitive `agent.sandbox.exec` uses — `wc -c` for the true
on-disk size, then `head -c maxBytes | base64` for a transport-safe payload.
Base64 keeps binary bytes intact through the exec channel; the decode happens
server-side, where valid UTF-8 is returned as text and anything else stays
base64. Only the Modal driver implements durable sessions today; the rest fail
closed via `requireDurableDriver()`, exactly like every other `agent.sandbox.*`
capability. A reaped sandbox is restored from its last snapshot and the read
retried once (same recovery contract as `agent.sandbox.exec`).

## Input

| Field       | Type                                    | Notes                                                                                   |
| ----------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `sessionId` | `string`                                | Durable-session id (`sbx_…`) returned by `agent.sandbox.start`.                           |
| `path`      | `string`                                | Workspace-relative file to read (e.g. `src/index.ts`). Must not be absolute or contain `..` segments (validated against `@oxagen/sandbox/workspace`). |
| `maxBytes`  | `number` (1–1 MiB, default 256 KiB)     | Maximum number of bytes to return. Larger files come back truncated.                      |

## Output

| Field       | Type                     | Notes                                                              |
| ----------- | ------------------------ | ------------------------------------------------------------------ |
| `path`      | `string`                 | Echoes the workspace-relative input path.                           |
| `content`   | `string`                 | File contents — UTF-8 text, or base64 when the file is binary.      |
| `encoding`  | `"utf8"` \| `"base64"`   | `base64` for NUL bytes / invalid UTF-8, so binary survives JSON.    |
| `sizeBytes` | `number`                 | Full on-disk size (may exceed the returned bytes).                  |
| `truncated` | `boolean`                | True when the file was larger than `maxBytes` and content was cut.  |

## Surfaces

- **API:** `POST /v1/:org/:workspace/agent/sandbox/file` — body `{ sessionId, path, maxBytes? }`
- **MCP:** `agent.sandbox_file.read` tool (read-only, idempotent)
- **Agent:** invoked via `invoke("agent.sandbox_file.read", ...)` — no approval required

## Access control

- Caller must be an authenticated workspace member.
- The session must belong to the caller's workspace and be running (a stopped or
  gone session throws `sandbox_session_not_found`).
- Default effect: **deny** — explicit role grant required (Org Owner/Admin,
  Workspace Owner/Member allowed by default).

## Side effects

- Runs a bounded `head -c … | base64` command inside the durable sandbox via
  `execInSession`.
- Postgres: bumps the session's `last_used_at` (and rebinds the sandbox id on a
  snapshot restore). No other writes.

## Errors

| code                          | meaning                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `durable_sandbox_unavailable` | No session-capable sandbox driver is configured.               |
| `sandbox_session_not_found`   | Session unknown, stopped, or out of the caller's workspace.    |
| `sandbox_session_gone`        | Session was reaped and has no snapshot to restore from.        |
| `validation_error`            | Input failed Zod parse (unsafe path, maxBytes out of range, …). |
| handler error                 | `no such file in the workspace` / `not a regular file` for a missing path or a directory. |
