# list_sandbox_logs

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Billing:** not gated (a read-only log tail consumes no AI tokens)

## Intent

Return the captured stdout/stderr/command output of a durable sandbox session's
commands, so the sandbox inspector's log console — plus MCP and agent
callers — can show what a coding session actually ran and printed. The `level`
filter drives the inspector's Debug toggle: `normal` returns only program
output, while omitting `level` (Debug ON) also includes command echoes,
timings, and other system/debug plumbing.

## Read model

Logs live in ClickHouse (append-only runtime telemetry, ~14-day TTL) and
**outlive the session row**, so a recently-flushed session's output is still
inspectable after its `sandbox_sessions` registry row is gone. The read is
**not** gated on the session row existing. Rows are fetched newest-first for the
tail, then returned in chronological order for a console. Tenant scoping is
enforced by the org/workspace filter inside the ClickHouse query, so a
cross-tenant `sessionId` simply returns no rows. When `sinceMs` is omitted the
window defaults to the last 24 hours.

## Input

| Field       | Type                              | Notes                                                                                   |
| ----------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| `sessionId` | `string`                          | Durable-session id (`sbx_…`) returned by `agent.sandbox.start`.                          |
| `level`     | `"normal" \| "debug"` (optional)  | `normal` returns only program output (Debug toggle OFF). Omit for all lines.             |
| `limit`     | `number` (1–2000, default 500)    | Max lines returned (the newest N, in chronological order).                               |
| `sinceMs`   | `number` (epoch-ms, optional)     | Floor on the line timestamp; defaults to 24h ago.                                        |

## Output

| Field   | Type              | Notes                                        |
| ------- | ----------------- | -------------------------------------------- |
| `lines` | `Array<LogLine>`  | Chronological order (oldest first). See below. |

Each `LogLine`:

| Field        | Type                                   | Notes                                                        |
| ------------ | -------------------------------------- | ----------------------------------------------------------- |
| `ts`         | `string`                               | `YYYY-MM-DD HH:MM:SS.mmm` (UTC), as ClickHouse renders it.   |
| `stream`     | `"stdout" \| "stderr" \| "system"`     | `system` is the command echo / exit-code / timing line.     |
| `level`      | `"normal" \| "debug"`                  | Verbosity bucket; `debug` rows are hidden when `level=normal`. |
| `command`    | `string`                               | The command this line belongs to (empty for stream lines).  |
| `seq`        | `number`                               | Monotonic per-command sequence for stable ordering.         |
| `line`       | `string`                               | The captured output line.                                   |
| `exitCode`   | `number \| null`                       | Exit code on a `system` summary line; null otherwise.       |
| `durationMs` | `number \| null`                       | Command duration on a `system` summary line; null otherwise. |

## Surfaces

- **API:** `POST /v1/:org/:workspace/agent/sandbox/logs` — body `{ sessionId, level?, limit?, sinceMs? }`
- **MCP:** `list_sandbox_logs` tool (read-only, idempotent)
- **Agent:** invoked via `invoke("list_sandbox_logs", ...)` — no approval required

## Access control

- Caller must be an authenticated workspace member.
- Only logs in the caller's workspace are returned (org + workspace scoped).
- Default effect: **deny** — explicit role grant required (Org Owner/Admin,
  Workspace Owner/Member allowed by default).

## Side effects

None. Pure read against ClickHouse; no writes and no driver interaction.

## Errors

| code               | meaning                                                              |
| ------------------ | ------------------------------------------------------------------- |
| `validation_error` | Input failed Zod parse (empty sessionId, limit out of range, etc.). |
