# Sandbox driver capability matrix

The `agent.sandbox.*` capabilities are vendor-neutral: every lifecycle operation
goes through the `SandboxDriver` seam (`@oxagen/sandbox`), and nothing in the
handlers, routes, or reaper knows about a specific provider. This note records
which driver supports which part of the durable-session surface, so it is
obvious what a given deployment can and cannot do.

## Drivers

| Driver     | One-shot `run`/`stream` | Durable sessions | `sessionStatus` | Snapshot / restore | Selected by |
| ---------- | :---------------------: | :--------------: | :-------------: | :----------------: | ----------- |
| **modal**  | ✅ | ✅ | ✅ | ✅ | `SANDBOX_DRIVER=modal` + `MODAL_RUNNER_URL` + `MODAL_RUNNER_TOKEN`, or auto-detected when those runner vars are present |
| **vercel** | ✅ | ❌ | ❌ | ❌ | `SANDBOX_DRIVER=vercel` (OIDC injected by the Vercel runtime) |
| **docker** | ✅ | ❌ | ❌ | ❌ | `SANDBOX_DRIVER=docker`, or the local-dev fallback when no driver is set and no modal vars are present |

"Durable sessions" means the full reconnectable-session surface —
`createSession` / `execInSession` / `snapshotSession` / `restoreSession` /
`stopSession` / `sessionStatus` — reported via `supportsSessions: true` and
verified at runtime by `isDurableSandboxDriver()`. Only **modal** implements it
today; the one-shot `agent.code.execute` path works on every driver.

## How a session picks its driver

Provider selection is **per session**, not per deployment. `sandbox_sessions`
records the provider that created the row in its `driver` column, and every
subsequent lifecycle op resolves the driver from that column:

- `requireDurableDriverForRow(row.driver)` — `exec`, `snapshot`, `file.read`,
  `file.list`: fail closed (throw `durable_sandbox_unavailable`) when that
  provider is not a configured durable driver, because they cannot proceed
  without a live session.
- `resolveSessionDriver(row.driver)` — `stop_sandbox` and the `list_sandboxes`
  reconcile: best-effort. A null result (provider unavailable / unconfigured /
  not durable) means the Postgres work still happens (the row is retired, or the
  reconcile is skipped for that row) rather than throwing.

A null `driver` column (only pre-column legacy rows) falls back to the
deployment-default driver. New rows always carry an explicit provider, so a
session started on one provider is never accidentally torn down or reconciled on
another.

## Gating

- `isSandboxAvailable()` is the single side-effect-free gate for "is any durable
  sandbox usable in this deployment?" It requires `SANDBOX_ENABLED=true` plus a
  configured driver, and is checked before advertising sandbox tools to the model
  and before the `list_sandboxes` reconcile runs.
- Adding a new durable driver means implementing the full `DurableSandboxDriver`
  surface and adding it to `SandboxProviderName` / the `getSandbox` switch — no
  handler, route, MCP tool, or reaper change is required, because they all go
  through the seam.
