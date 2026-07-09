# list_sandboxes

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent, cli
**Risk level:** low
**Billing:** not gated (a read-only registry listing consumes no AI tokens)

## Intent

Enumerate the durable sandbox sessions in the caller's workspace — the rows in
`sandbox_sessions` created by `agent.sandbox.start` — so the app's "sandbox
detail" page (plus CLI, MCP, and agent callers) can show which sessions exist,
their lifecycle status, and when each was last used, without probing every
session id one at a time.

## Read model

Unlike the other `agent.sandbox.*` capabilities, this one never resolves a live
sandbox driver: it is a pure Postgres read against the `sandbox_sessions`
registry, so it works whether or not a durable driver is configured and returns
instantly. Soft-deleted rows are excluded; an optional `status` narrows the
lifecycle state. Results are ordered by `last_used_at DESC` (nulls last), then
`created_at DESC`, so the most recently active sessions surface first. The
driver-internal live sandbox id / snapshot id are never exposed — only the
opaque public id (`sbx_…`).

## Input

| Field    | Type                                             | Notes                                                                          |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `status` | `"running" \| "idle" \| "stopped" \| "gone"` (optional) | Filter to sessions in this lifecycle status. Omit to include every non-deleted session. |
| `limit`  | `number` (1–100, default 50)                     | Maximum number of sessions to return.                                          |

## Output

| Field       | Type                | Notes                                                              |
| ----------- | ------------------- | ----------------------------------------------------------------- |
| `sandboxes` | `Array<Sandbox>`    | Most-recently-used first. See fields below.                       |

Each `Sandbox`:

| Field        | Type                                             | Notes                                                    |
| ------------ | ------------------------------------------------ | -------------------------------------------------------- |
| `sessionId`  | `string`                                         | Opaque durable-session id (`sbx_…`) — the public id.     |
| `sessionKey` | `string \| null`                                 | Caller-supplied reuse key, or null for ephemeral sessions. |
| `image`      | `"node" \| "python" \| "shell" \| "agent"`       | Runtime base image.                                      |
| `status`     | `"running" \| "idle" \| "stopped" \| "gone"`     | Lifecycle status.                                        |
| `driver`     | `string`                                         | Sandbox driver identifier (e.g. `modal`).                |
| `lastUsedAt` | `string \| null`                                 | ISO timestamp of the most recent interaction, or null.  |
| `expiresAt`  | `string \| null`                                 | ISO soft-expiry timestamp, or null when no expiry.       |
| `createdAt`  | `string`                                         | ISO timestamp the session was created.                  |

## Surfaces

- **API:** `POST /v1/:org/:workspace/agent/sandbox/list` — body `{ status?, limit? }`
- **MCP:** `list_sandboxes` tool (read-only, idempotent)
- **Agent:** invoked via `invoke("list_sandboxes", ...)` — no approval required
- **CLI:** `oxagen sandbox list [--status <status>] [--limit <n>] [--json]`

## Access control

- Caller must be an authenticated workspace member.
- Only sessions in the caller's workspace are returned (org + workspace scoped).
- Default effect: **deny** — explicit role grant required (Org Owner/Admin,
  Workspace Owner/Member allowed by default).

## Side effects

None. Pure read; no Postgres writes and no driver interaction.

## Errors

| code               | meaning                                                       |
| ------------------ | ------------------------------------------------------------ |
| `validation_error` | Input failed Zod parse (status not in the enum, limit out of range). |
