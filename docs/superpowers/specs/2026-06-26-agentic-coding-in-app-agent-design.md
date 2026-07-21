# Design: Agentic coding in the in-app agent

**Date:** 2026-06-26
**Branch:** `feat/agentic-coding-runner`
**Status:** Approved design — implementation plan to follow.

> **Superseded for launch (2026-07-21).** This design is retained as historical
> context. Its central `SourceFile`/`SourceSymbol` and code-embedding assumptions
> are retired: exact code graphs stay local, while Oxagen retains provider metadata
> and durable run traces. Canonical protected/default-ref topology and typed run
> evidence are separate follow-ups.

## Goal

Let the in-app agent modify code in GitHub repos that are connected as knowledge
sources: a user `@`-mentions a connected repo, describes a change, and the system
checks out the repo in a cloud sandbox, makes the edits with a Claude-Code-style
agentic loop, runs builds/tests, pushes a branch, opens a pull request, and then
monitors CI and autonomously fixes failures until green (capped).

## Decisions (locked)

| Decision | Choice | Consequence |
|---|---|---|
| Execution runtime | **Persistent Vercel Sandbox** | Clone-once, many edit/build/test cycles in a Firecracker microVM; Vercel-native, ejectable later. Extends the existing 3-driver `packages/sandbox` abstraction. |
| Git identity | **Acting user's OAuth token** | Branches/commits/PRs authored as the human. Requires upgrading the GitHub OAuth scope to include write (`repo` or fine-grained `contents:write` + `pull_requests:write`) — Phase 2 only. |
| Autonomy posture | **Fully autonomous** | Push + ready (non-draft) PR + CI auto-fix loop run with no human gate, bounded by hard caps (iterations, wall-clock, files-changed, credit budget). |
| First slice | **Coding runner first** | Phase 1 produces a diff + summary only; GitHub writes (Phase 2) and CI loop (Phase 3) layer on top. |
| CLI convergence | **One shared engine** | Extract the CLI's existing coding loop into `@oxagen/coding-agent`; both CLI and cloud runner consume it. |
| Phase-1 streaming | **Poll-based background-task tray**, live SSE tail as fast follow | Ships faster on existing infra; richer live view is additive. |

## Current-state findings (what already exists)

- **Repo connection:** GitHub repos connect via OAuth (user-to-server token), ingested
  by Inngest into Neo4j as `:SourceFile` / `:SourceSymbol` + embeddings. Full file
  blobs are **not** stored — content is fetched on-demand by SHA. `repo.*` contracts
  (`configure`/`sync`/`pause`/`resume`/`metrics`) are read/sync only.
  - Connector: `packages/ingestion/src/connectors/github/index.ts`
  - OAuth tokens (KMS-encrypted): `ingestion.oauth_accounts` in `packages/database/src/schema/ingestion.ts`
  - Connections: `ingestion.source_connections` (status `connected`, `deliveryConfig` has `installationId`/`owner`/`repo`/`defaultBranch`)
  - Webhook: `POST /webhooks/github/app` — `apps/api/src/routes/v1/github-webhook.ts` (today excludes `check_run`/`workflow_run`)
- **In-app agent:** `apps/api/src/routes/v1/chat.stream.ts` → `streamAgentReply()`
  (`packages/ai/src/stream.ts`) → AI SDK `streamText` with `materializeTools()`
  (`packages/agent/src/runtime/materialize-tools.ts`). Multi-step tool loop already works.
  Client consumer: `apps/app/src/components/chat/use-tool-stream.ts`.
- **Sandbox:** `agent.code.execute` wired with a 3-driver abstraction
  (`packages/sandbox/src/{vercel,modal,docker}.ts`), but **single-shot & stateless** —
  not a persistent repo workspace.
- **Background jobs:** Inngest `agent.background-task.execute`
  (`packages/inngest-functions/src/functions/agent.background-task.execute.ts`) with a
  `backgroundTasks` status row, cancel via `cancelOn`, and a polling tray UI
  (`apps/app/src/components/chat/background-task-tray.tsx`, 2–30s backoff).
- **Secrets:** org-scoped KMS-encrypted credentials in Postgres, retrievable server-side
  (`packages/plugins/src/credentials/`, `AUTH_TOKEN_ENCRYPTION_KEY`).
- **CLI:** a real FS-coupled coding loop (`apps/cli/src/agent/loop.ts`, `tools.ts`:
  `read_file`/`write_file`/`edit_file`/`list_dir`/`glob`/`grep`/`code_graph`/`bash`,
  `stopWhen: stepCountIs(32)`) — coupled to Node `fs` + Ink, not reusable server-side as-is.

## Gaps (what we build)

1. **Zero GitHub write capability** — no Octokit anywhere; no branch/commit/PR creation,
   no CI/check-run reads, OAuth scopes are read-oriented.
2. **No persistent coding workspace** — sandbox can't clone-once-then-iterate.
3. **No CI-feedback loop** — nothing watches check runs and feeds failures back.
4. **No `@`-mention UX** — composer is a plain textarea.

## Phasing

| Phase | Deliverable | Autonomy |
|---|---|---|
| **1 — Coding runner** | Persistent sandbox + shared coding engine → **diff + summary** against a connected repo, streamed into chat as a background task. No GitHub writes. | n/a |
| **2 — VCS write layer** | Octokit wrapper + OAuth scope upgrade → push branch (user token), open **ready PR**. | push + PR autonomous |
| **3 — CI auto-fix loop** | Watch check runs (webhook + Octokit) → feed failures to the runner → fix & re-push, capped at N. | full loop, no gate |
| **Cross-cutting — `@`-mention UX** | Composer `@repo` autocomplete → structured mention resolving to a `connectionId`. | — |

## Phase 1 — the coding runner (detailed)

### `@oxagen/coding-agent` (new package)

The engine, filesystem-agnostic so CLI and cloud share it.

- **`Workspace` interface:** `readFile` / `writeFile` / `editFile` / `list` / `glob` /
  `grep` / `exec` / `diff`. Backends:
  - `LocalWorkspace` — Node `fs` + `child_process`; consumed by `apps/cli` (refactored).
  - `SandboxWorkspace` — backed by the persistent Vercel Sandbox.
  - `MemoryWorkspace` — in-memory, for deterministic unit tests.
- **`runCodingAgent({ workspace, instruction, model, repoContext, caps })`:** a tool-using
  `streamText` loop via `@oxagen/ai` (so metering/telemetry/credit-charging come for free).
  Tools are bound to the `Workspace`. The `code_graph` tool queries the **existing Neo4j
  `:SourceFile`/`:SourceSymbol` ingestion** for symbol-level repo awareness without
  re-indexing. Emits a typed event stream: `text`, `reasoning`, `tool-call`, `file-edit`,
  `command-output`, `final-diff`. Terminates on `stopWhen` (step cap) or explicit completion.
- **Caps:** `maxSteps`, `maxWallClockMs`, `maxFilesChanged`, credit/token budget.

### `packages/sandbox` (extended)

Add a persistent `createWorkspace()` (clone-once, many `exec`) alongside the existing
single-shot `run()`. Vercel Sandbox supports multi-command sessions, so this is additive
and does not change `agent.code.execute` behavior.

### Contracts (full parity: contract → API → MCP → CLI → docs)

- `agent.coding.session.start` — `{ connectionId, instruction, baseBranch? }` → `{ sessionId }`. Async.
- `agent.coding.session.get` — `{ sessionId }` → status + event list + `diff` + `changedFiles` + summary.
- `agent.coding.session.cancel` — `{ sessionId }` → cancels via Inngest `cancelOn`.

Surfaces: `agent`, `api`, `mcp`, `cli`. Docs in `docs/capabilities/`.

### Orchestration

1. Chat agent (or API/MCP/CLI) invokes `agent.coding.session.start`.
2. Handler (`packages/handlers`) inserts a `coding_sessions` row (org+workspace scoped,
   RLS) and emits an Inngest event. Thin — orchestration lives in Inngest.
3. Inngest fn (`packages/inngest-functions`):
   - Resolve repo ref from `source_connections`; fetch + **KMS-decrypt** the user OAuth token.
   - Provision a persistent Vercel Sandbox; `git clone` (shallow, scoped token in remote URL).
   - Run `runCodingAgent` with a `SandboxWorkspace`; persist each emitted event to
     `coding_session_events`.
   - `git diff` → persist `diff` + `changedFiles` + summary; mark row terminal; tear down sandbox.
   - Each step that touches `scopedSession`/`withTenantDb` is wrapped in `runInTenantScope`
     (Inngest step-scope gotcha — ALS does not cross step boundaries).
4. In-app surface: the chat stream emits a `background-task` event; the existing tray polls
   `agent.coding.session.get` and renders progress + the final diff. (SSE live token-tail = fast follow.)

### Database

- `coding_sessions` — `publicId`, `orgId`, `workspaceId`, `connectionId`, `instruction`,
  `baseBranch`, `status` (pending|running|completed|failed|cancelled), `inngestRunId`,
  `diff`, `changedFiles` (jsonb), `summary`, `failureReason`, timestamps.
- `coding_session_events` — append-only event log (kind, payload jsonb, seq, ts).
- RLS policies + `oxagen_app` grants; migration in `packages/database/migrations/`.

### CLI refactor

Refactor `apps/cli/src/agent/` to consume `@oxagen/coding-agent` via `LocalWorkspace`,
deleting the now-duplicated loop/tool code. One engine, two filesystems. Preserves CLI
behavior (verified by the existing/added CLI agent tests).

## Phase 2 — VCS write layer (sketch)

- New `@oxagen/github` (Octokit wrapper): branch create, push (git from sandbox using the
  user token in the remote), open PR, read PR status.
- OAuth scope upgrade: incremental re-consent on the connection to obtain write scope; store
  upgraded token. Guard: never push to the default branch — always a new branch + PR.
- Contracts: `repo.pr.open`, `repo.pr.get` (parity). IAM-gated by a repo-write role.

## Phase 3 — CI auto-fix loop (sketch)

- Extend `POST /webhooks/github/app` to route `check_run`/`workflow_run` events to the active
  session (currently excluded by the connector).
- Fallback: poll Octokit checks API.
- On failure: resume/re-provision the sandbox, feed failing logs to `runCodingAgent`, fix,
  re-push. Cap iterations (default 3). On green or cap, finalize. Fully autonomous — no gate.

## `@`-mention UX (cross-cutting)

Enhance `apps/app/src/components/chat/message-composer.tsx`: typing `@` opens an autocomplete
of connected repos (and later files). Selection inserts a structured mention token resolving
to a `connectionId`, passed as repo context to the agent. Uses `@oxagen/ui` (coss/Base UI).

## Component boundaries

| Unit | Responsibility | Depends on |
|---|---|---|
| `@oxagen/coding-agent` | Engine + `Workspace` abstraction + tools | `@oxagen/ai`, Neo4j (code_graph) |
| `packages/sandbox` (ext.) | Persistent Vercel Sandbox workspace | `@vercel/sandbox` |
| `packages/handlers` | `agent.coding.session.*` handlers (thin) | DB, Inngest |
| `packages/inngest-functions` | Long-running session executor | sandbox, coding-agent, DB |
| `packages/database` | `coding_sessions` + events schema, RLS | — |
| `apps/cli` | `LocalWorkspace` consumer (refactored) | `@oxagen/coding-agent` |
| `apps/app` | Background-task render of session; `@repo` mention | chat stream, tray |

## Error handling & guardrails (invariants — hold even under full autonomy)

- **Tenancy/IAM:** session org+workspace scoped via `withTenantDb`; gated by a capability +
  repo-write IAM role (high-risk). `runInTenantScope` per Inngest step.
- **Isolation:** untrusted repo code runs only in the Vercel Sandbox; egress controls; only
  a short-lived scoped git token enters the sandbox; secrets never broadly injected.
- **Caps:** max steps, max wall-clock, max files changed, credit/token budget via `invoke()`;
  never push to default branch (Phase 2).
- **Audit:** every session + tool call → ClickHouse ("instrument everything").
- **Cancel:** `agent.coding.session.cancel` → Inngest `cancelOn`.
- **Billing:** metered through `invoke()` / credits.

## Testing

- **Unit:** engine loop against `MemoryWorkspace` (deterministic, no sandbox); each tool;
  diff extraction; CLI parity after refactor.
- **Integration:** handler + contract parity (`check:manifest`); RLS scoping on
  `coding_sessions`; Inngest step tenant-scope.
- **E2E:** chat → start session against a seeded connected repo → assert a non-empty diff
  renders in the tray (Playwright + screenshot to `apps/app/e2e/screenshots/`).
- **Gate:** per-package `test:unit` only during work; full `pnpm gate` pre-merge. Coverage
  ratchet ≤90 with ≥2.5% headroom.

## Out of scope (YAGNI)

- Multi-repo changes in a single session.
- Non-GitHub VCS (GitLab/Bitbucket).
- Installation-token identity (explicitly chose user-OAuth identity).
- Storing full repo blobs at rest (clone on demand).
- Human approval gates (explicitly chose full autonomy; caps replace gates).

## Open follow-ups (tracked, not blocking)

- Phase 2 OAuth write-scope upgrade UX + token refresh.
- SSE live token-tail for "watch it code".
- Default-branch protection enforcement test.
