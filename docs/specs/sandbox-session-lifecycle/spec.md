# Sandbox Session Lifecycle — persistent per-session sandboxes with guaranteed work recovery

Status: **draft** · Owner: platform · Created: 2026-07-09

## 1. Problem

A coding session needs a durable, inspectable execution environment, but running
sandboxes cost money and must not linger. Today the platform does neither well:

- **No persistence.** The app chat route (`apps/app/.../chat/stream/route.ts`)
  calls `codeWorkspace.dispose()` in a `finally` at the end of **every turn**,
  which stops the Modal sandbox and **soft-deletes** the `agent.sandbox_sessions`
  row (`markSessionStatus('stopped')` sets `deleted_at`). `findReusableSession`
  only matches `status IN ('running','idle') AND deleted_at IS NULL`, so the next
  turn misses the row and **provisions a fresh sandbox and re-clones the repo**.
  Uncommitted work from turn N is destroyed when turn N's sandbox is terminated.
- **No inspector.** A `studio/sandboxes/[sessionId]` page exists (terminal +
  file tree), but there is no live state, no log console, and no debug toggle.
- **No Oxagen-side reaper.** Reaping is entirely Modal-side (`idle_timeout` 20 min,
  `ttl` 24 h). `expires_at` is written but never read; the `'idle'` status is
  defined but never set. Idle sandboxes burn cost for up to 20 minutes.
- **No work-safety net.** Nothing detects uncommitted changes before a sandbox is
  dropped, and nothing pushes that work anywhere.

## 2. Goals

1. **Persistent per-session sandbox.** One durable Modal sandbox per coding
   session (conversation), reused warm across turns — repo cloned once, working
   tree (including uncommitted edits) preserved between turns.
2. **Inspectable.** Rich live state, a navigable disk file-tree, an output-log
   console with a debug-verbosity toggle.
3. **Auto-drop when idle.** A reaper terminates a session's sandbox **2-3 minutes**
   after the session goes idle (no active turn), far tighter than Modal's 20 min.
4. **Never lose uncommitted work.** The reaper **must not** flush a sandbox with a
   dirty working tree. It first pushes the uncommitted work to a dedicated
   **recovery branch** (`recovery/<session>/<utc-ts>`), and only flushes once the
   tree is provably preserved. If recovery cannot complete, the sandbox is **kept**.
5. **Fresh re-entry.** After a session is flushed, re-entering the coding session
   provisions a brand-new sandbox (fresh clone); the prior work is safe on its
   recovery branch.

**Non-goal (this epic):** moving locally-run coding sessions into sandboxes. A
local runner works against the checkout directly (`CwdWorkspace`) and keeps its
own `commit-ledger` safety net.

## 3. The hard invariant

> **The idle/TTL timer can never override work-safety.** A dirty sandbox is only
> ever terminated *after* its uncommitted work has been captured to a durable
> recovery branch. If capture fails, the sandbox is retained (`recovery_failed`)
> and flagged for manual attention. Losing uncommitted work is a correctness bug,
> not a cost trade-off.

## 4. Lifecycle model

Two orthogonal state axes on `agent.sandbox_sessions`:

- **`status`** (existing, driver liveness): `running → idle → stopped | gone`.
  - `running` — an agent turn is actively holding the session.
  - `idle` — no active turn; sandbox is warm and reusable. **Newly used.**
  - `stopped` — explicitly torn down (soft-deleted).
  - `gone` — the driver reaped it out from under us (discovered lazily).
- **`recovery_status`** (new, work-safety): `none → pending → recovering →
  recovered | failed`.

### Turn boundaries (app route change)

- **Turn start** → `touchSession` sets `status='running'`, `last_used_at=now()`.
- **Turn end** (success or error) → `release()`: `status='idle'`,
  `last_used_at=now()`. **Do NOT dispose** — the sandbox stays warm. (Only the
  per-run one-shot `agent.repo.edit` sessions keep calling `dispose()`.)
- **Reuse** → the next turn's `findReusableSession` now finds the `idle` row,
  reconnects to the still-live Modal sandbox, skips re-clone (the `.git` marker),
  and continues on the same working tree.

### Reaper (net-new)

A 1-minute Inngest cron (`agent.sandbox-reaper`), `withSystemDb`, concurrency 1,
mirroring `agent.lease-sweep`. Each tick, in tenant-scoped batches:

1. **Idle-grace flush.** Rows with `status='idle' AND last_used_at < now() -
   graceSeconds` (default **120 s**, env `SANDBOX_SESSION_GRACE_SECONDS`). Cron
   granularity adds ≤60 s ⇒ real-world drop lands in the **2-3 min** target.
2. **Stale-running backstop.** Rows with `status='running' AND last_used_at <
   now() - staleRunningSeconds` (default **30 min**, longer than any real turn) —
   a crashed turn that never released. Treated as idle.
3. For each candidate, run the **atomic recover-then-flush** (§6). Bail if the row
   was touched again between select and act (a turn resumed).

A short `grace_deadline_at` column (= `last_used_at + graceSeconds`, written on
`release`) drives the UI countdown and lets the reaper index-scan candidates.

## 5. Schema changes

### 5.1 Postgres — `agent.sandbox_sessions` (additive, all nullable/defaulted)

| column | type | purpose |
|---|---|---|
| `grace_deadline_at` | `timestamptz null` | reap-eligible time (`last_used_at + grace`); UI countdown + reaper index |
| `recovery_status` | `text not null default 'none'` | `none\|pending\|recovering\|recovered\|failed` (CHECK) |
| `recovery_branch` | `text null` | branch created for the uncommitted work |
| `recovery_commit` | `text null` | commit sha on the recovery branch |
| `recovery_error` | `text null` | failure reason when `recovery_status='failed'` |
| `recovered_at` | `timestamptz null` | when recovery completed |
| `flushed_at` | `timestamptz null` | when the reaper terminated the sandbox |
| `dirty` | `boolean null` | last-observed uncommitted-changes state (null=unknown) |
| `dirty_checked_at` | `timestamptz null` | when `dirty` was last computed |

Plus a partial index for the reaper:
`(grace_deadline_at) WHERE flushed_at IS NULL AND grace_deadline_at IS NOT NULL`.

The **repo binding** needed for recovery rides in the existing `metadata` jsonb as
`repo: { owner, repo, ref }` (written by `ModalSandboxWorkspace` at bootstrap — no
new column, no contract change). Its presence marks a session as repo-backed
(recoverable); its absence marks a raw/eval sandbox (snapshot-and-keep on dirty).

Migration: `20260719120000_agent_sandbox_session_lifecycle.sql` (RLS/grants follow
the existing `sandbox_sessions` pattern; additive `ALTER TABLE ... ADD COLUMN`).

### 5.2 ClickHouse — `sandbox_log_events` (append-only, four-store law)

Sandbox output is runtime telemetry ⇒ ClickHouse, never Postgres. One row per
exec stdout/stderr chunk:

```
sandbox_log_events (
  org_id, workspace_id, session_id (sbx_…),
  ts DateTime64(3), stream Enum('stdout','stderr','system'),
  level Enum('normal','debug'), command String, seq UInt32, line String,
  exit_code Nullable(Int32), duration_ms Nullable(UInt32)
)  ENGINE = MergeTree ORDER BY (org_id, workspace_id, session_id, ts)
   TTL toDateTime(ts) + INTERVAL 14 DAY
```

`level='debug'` carries verbose plumbing (env injection, restore-on-reap, git
recovery internals); `normal` carries agent-issued command output. The inspector's
debug toggle filters on `level`.

## 6. Recovery routine (§3 invariant, on-demand + reaper)

Modelled exactly on `agent.repo.edit.ts` (create-branch + Contents-API commit),
minus the PR. Given a session row:

1. **Dirty check.** `git add -A && git diff --cached --name-only --diff-filter=d`
   inside `/work` via `execInSession` (reuses `ModalSandboxWorkspace.getChangedFiles`).
   Empty ⇒ clean ⇒ skip to flush. Persist `dirty` + `dirty_checked_at`.
2. **Repo-backed?** If `metadata.repo` is absent ⇒ can't push. If dirty, snapshot
   the filesystem and **keep** the sandbox (`recovery_status='failed'`,
   `recovery_error='no repo binding'`); never flush. If clean, flush.
3. **Recover.** `recovery_status='recovering'`. Mint a **fresh** installation token
   via `resolveGitHubToken` (not the stale clone token — sessions can outlive a
   1 h token). `gh.createBranch({ branch: recovery/<sessionShort>/<utc-ts>,
   fromBranch: ref })`; `gh.putFile(...)` each changed file. Record
   `recovery_branch`, `recovery_commit`, `recovered_at`, `recovery_status='recovered'`.
4. **Flush.** Terminate the Modal sandbox (`stopSession`), set `status='stopped'`,
   `flushed_at=now()`, soft-delete. A subsequent re-entry provisions fresh.
5. **Failure ⇒ keep.** Any error in 3-4 ⇒ `recovery_status='failed'` +
   `recovery_error`; **do not** terminate. The next reaper tick retries; the UI
   shows a "manual recovery needed" banner.

Recovery is **idempotent**: keyed on the session id; a branch collision reuses the
existing recovery branch. Also exposed as an on-demand capability
(`recover_sandbox_session`) so a user can force-recover from the inspector.

## 7. Observability

### 7.1 Inspector UI — extend `studio/sandboxes/[sessionId]`

Reuse the existing components; add three panels:

- **State panel** — status badge, image/driver, uptime, **idle countdown to reap**
  (from `grace_deadline_at`), resource spec, dirty indicator, and a **recovery
  banner** (branch link when recovered; "manual recovery needed" + a Recover
  button when failed).
- **Logs console** — `TerminalTraceCard`-style scrollback fed by `list_sandbox_logs`,
  **live-tailing** (poll first; SSE follow-up), with a **Debug toggle** that
  includes `level='debug'` rows.
- **File tree** — already present (`WorkspaceContextPanel` + `FileTreeCard`).

Bind the session-level capabilities in `apps/app/capability-ui-map.json` (they are
currently unbound — a standing parity gap this epic closes).

### 7.2 Log capture

`agent.sandbox.exec` handler appends stdout/stderr to `sandbox_log_events`
(fail-soft, like lease telemetry). Recovery/reaper internals log at `level='debug'`.

## 8. Capabilities & parity

New contracts (full api/mcp/app parity + docs + capability-ui-map binding):

- `list_sandbox_logs` — `{ sessionId, level?, since?, limit }` → log rows (tail).
- `recover_sandbox_session` — `{ sessionId }` → `{ recoveryBranch, recoveryCommit }`.
- `get_sandbox_session` — rich single-session state (superset of the `list` row).

Existing `list_sandboxes` / `sandbox_file.*` gain the `app` layer + binding.

## 9. Phasing (each a mergeable increment on this branch)

1. **Spec** (this doc).
2. **Schema + lifecycle core** — PG migration + Drizzle + reaper (`agent.sandbox-reaper`)
   + recovery routine + `release()` and the app-route change (idle-not-dispose) +
   metadata repo binding. *The work-safety heart.*
3. **Log capture** — CH table + exec-handler append + `list_sandbox_logs` (parity).
4. **Inspector UI** — state panel + logs console + debug toggle + recovery banner;
   capability-ui-map bindings.
5. **Capability docs.**

## 10. Testing

- Reaper: idle past grace → recovered+flushed; dirty w/o repo → kept; touched
  mid-grace → not reaped; stale-running backstop; recovery failure → kept.
- Recovery: dirty tree → branch created with exact changed files; clean → no branch;
  fresh-token path; idempotent re-run.
- Route: turn end marks idle (not stopped); next turn reuses same session/sandbox,
  no re-clone; dirty work survives across turns.
- Log capture: exec output lands in CH; debug rows filtered by toggle.
- E2E: inspector renders state/logs/tree; debug toggle; recover button.

## 11. Config

| env | default | meaning |
|---|---|---|
| `SANDBOX_SESSION_GRACE_SECONDS` | `120` | idle → reap grace window |
| `SANDBOX_SESSION_STALE_RUNNING_SECONDS` | `1800` | crashed-turn backstop |
| `SANDBOX_LOG_RETENTION_DAYS` | `14` | CH TTL for log events |

## 12. Risks

- **Cost of persistence.** Warm sandboxes cost until reaped — mitigated by the
  aggressive 2-3 min reaper (vs Modal's 20 min) and the stale-running backstop.
- **Reaper outage.** If Inngest is down, Modal's idle_timeout (20 min) is the
  ultimate backstop — sandboxes still drop, just later; work is unaffected.
- **Token expiry on long sessions.** Recovery mints a fresh token (never reuses the
  clone token), so a >1 h session still recovers.
- **Migration collision.** Timestamp chosen well past the current max; regenerate
  `atlas.sum` via `atlas migrate hash`.
