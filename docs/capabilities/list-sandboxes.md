# list_sandboxes

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Billing:** not gated (a read-only registry listing consumes no AI tokens)

## Intent

Enumerate the durable sandbox sessions in the caller's workspace — the rows in
`sandbox_sessions` created by `agent.sandbox.start` — so the app's "sandbox
detail" page (plus MCP and agent callers) can show which sessions exist,
their lifecycle status, and when each was last used, without probing every
session id one at a time.

## Read model

The registry read is a Postgres query against `sandbox_sessions`: soft-deleted
rows are excluded, an optional `status` narrows the lifecycle state, and results
are ordered by `last_used_at DESC` (nulls last), then `created_at DESC`, so the
most recently active sessions surface first. The driver-internal live sandbox id
/ snapshot id are never exposed — only the opaque public id (`sbx_…`).

The read is followed by a **bounded live reconcile** so the list never reports a
session as running/idle that its provider has already terminated. Each
running|idle row is checked against **its own driver's** `sessionStatus` (keyed
on the row's `driver` column — vendor-neutral, never the deployment default),
capped at 25 driver calls per request, run with `Promise.allSettled` so a
single provider hiccup can't fail the listing. When the provider reports a
session gone, the row is corrected to `stopped` with the same terminal semantics
as an explicit stop (soft-deleted) and the fix persisted. When no durable driver
is configured, the reconcile is skipped entirely and the raw registry view is
returned — so the capability still works with no sandbox backend and consumes no
AI tokens (`noBillingGate`).

## Input

| Field        | Type                                             | Notes                                                                          |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `status`     | `"running" \| "idle" \| "stopped" \| "gone"` (optional) | Filter to sessions in this lifecycle status (applied after reconcile). Omit to include every non-deleted session. |
| `activeOnly` | `boolean` (default `false`)                      | When true, return only sessions that are running or idle **after** reconcile — sessions the provider already terminated are dropped. |
| `limit`      | `number` (1–100, default 50)                     | Maximum number of sessions to return.                                          |

## Output

| Field       | Type                | Notes                                                              |
| ----------- | ------------------- | ----------------------------------------------------------------- |
| `sandboxes` | `Array<Sandbox>`    | Most-recently-used first. See fields below.                       |

Each `Sandbox`:

| Field        | Type                                             | Notes                                                    |
| ------------ | ------------------------------------------------ | -------------------------------------------------------- |
| `sessionId`  | `string`                                         | Opaque durable-session id (`sbx_…`) — the public id.     |
| `sessionKey` | `string \| null`                                 | Caller-supplied reuse key, or null for ephemeral sessions. |
| `label`      | `string \| null`                                 | Human-friendly display name (from `start_sandbox` or `rename_sandbox`), or null. |
| `image`      | `"node" \| "python" \| "shell" \| "agent"`       | Runtime base image.                                      |
| `status`     | `"running" \| "idle" \| "stopped" \| "gone"`     | Lifecycle status (post-reconcile; a provider-dead row reads `stopped`). |
| `driver`     | `string`                                         | Sandbox driver identifier (e.g. `modal`).                |
| `repos`      | `Array<{ owner, repo, branch? }>` (optional)     | Repositories provisioned into the sandbox at start time; omitted when none. |
| `lastUsedAt` | `string \| null`                                 | ISO timestamp of the most recent interaction, or null.  |
| `expiresAt`  | `string \| null`                                 | ISO soft-expiry timestamp, or null when no expiry.       |
| `createdAt`  | `string`                                         | ISO timestamp the session was created.                  |

Work-recovery fields (`recoveryStatus`, `recoveryBranch`, `recoveryCommit`,
`graceDeadlineAt`, `dirty`, `flushedAt`, `recoveredAt`) also ride each row — see
`docs/specs/sandbox-session-lifecycle`.

## Surfaces

- **API:** `POST /v1/:org/:workspace/agent/sandbox/list` — body `{ status?, activeOnly?, limit? }`
- **MCP:** `list_sandboxes` tool (idempotent)
- **Agent:** invoked via `invoke("list_sandboxes", ...)` — no approval required

## Access control

- Caller must be an authenticated workspace member.
- Only sessions in the caller's workspace are returned (org + workspace scoped).
- Default effect: **deny** — explicit role grant required (Org Owner/Admin,
  Workspace Owner/Member allowed by default).

## Side effects

Self-healing only: when the live reconcile finds a running|idle row whose
provider reports the session gone, it marks that row `stopped` (soft-delete) so
the stale status is corrected on read. No other Postgres writes. When no durable
driver is configured there is no reconcile and no write at all.

## Errors

| code               | meaning                                                       |
| ------------------ | ------------------------------------------------------------ |
| `validation_error` | Input failed Zod parse (status not in the enum, limit out of range). |
