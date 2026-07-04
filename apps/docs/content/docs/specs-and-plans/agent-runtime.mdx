---
title: "Agent Runtime"
description: "Archived spec & plan — status: partially shipped (audited 2026-07-03)."
---

> **Status: Partially shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The Agent Runtime spec has been substantially implemented across all layers: contracts, packages, database, API, MCP, and Chat UI. 16 capabilities are declared and fully wired with handlers, routes, tools, and tests. Core packages (agent, sandbox, skills) are production-ready with Docker/Modal/Vercel sandbox drivers. Chat UI includes all five promised components. One gap: Neo4j edge types (INVOKED, LOADED_SKILL) mentioned in spec section 6 are not found in migrations, suggesting Neo4j schema work may be incomplete or delayed.

**Implementation evidence**

- packages/oxagen/src/contracts/agent.*.ts — 16 capability contracts with handlers
- packages/agent/src/handlers — 111 handler implementations covering all capabilities
- packages/sandbox/src/\{docker,modal,vercel}.ts — three sandbox drivers fully implemented
- packages/skills/src/\{loader,registry,filesystem,seed}.ts — skill loading infrastructure
- apps/app/src/components/chat/\{tool-call-card,approval-card,plan-card,subagent-fanout,background-task-tray}.tsx — all 5 UI components
- apps/api/src/routes/v1/agent.*.ts — 50+ API routes covering all capabilities
- apps/mcp/src/tools/agent.*.ts — 50+ MCP tools matching API routes
- packages/database/atlas/migrations/20260611233016_initial_schema.sql — Postgres tables: approval_requests, background_tasks, skills, skill_versions, agent_tool_calls
- packages/telemetry/src/migrations — ClickHouse tool_invocations and execution_logs tables
- packages/agent/src/hooks/runtime.ts — hooks for before_tool, after_tool, on_error with execution_logs
- git log main — PRs #551, #527, #484, #435 show merged implementation across 6 months

**Known gaps at time of archive**

- Neo4j edge types INVOKED and LOADED_SKILL (spec section 6) — no migration or schema definition found; may be handled in code rather than migrations

**Source documents** (archived verbatim below)

- `docs/specs/agent-runtime/spec.md`
- `docs/specs/agent-runtime/plan.md`

## Spec — `spec.md`

## Agent Runtime — Design Specification

### 1. Scope

This epic gives the interactive agent in `apps/app` (and any MCP client
connected to `apps/mcp`) parity with Claude Code's runtime feature set:

1. **Typed tool surface.** A capability-style tool registry beyond the
   four foundation capabilities, with per-tool input/output schemas
   shared between API, MCP, and chat UI.
2. **External MCP client.** The runner can connect to third-party MCP
   servers and surface their tools as Oxagen tools, tenant-scoped.
3. **Subagent dispatch.** A first-class `agent.subagent.dispatch` tool
   that fans out independent work through Inngest and aggregates
   results.
4. **Code execution.** A sandboxed code-execution tool, isolated per
   tenant.
5. **Plan mode.** A distinct mode where the agent produces a structured
   plan that the user approves before any side-effectful tool runs.
6. **Skills.** Discoverable, file-based or DB-backed skills the agent
   loads on demand.
7. **Hooks.** Per-workspace shell-style hooks fired around tool calls.
8. **Tool-call approval.** A UI flow where high-blast-radius tools
   require explicit user approval mid-stream.
9. **Background tasks.** Durable, long-running agent work tracked as
   Inngest jobs and surfaced in the UI.
10. **Memory recall and write.** Reads from the Neo4j `AgentMemory`
    nodes the foundation milestone already provisions; writes new
    memories with weight per the `oxagen-feature` skill's weighting
    contract.

Out of scope: marketplace skills/plugins discovery UI, billing
controls per tool (token cost is already tracked).

### 2. Goals and Acceptance Criteria

The epic is complete when **all** of the following are true:

1. A user in `apps/app` can hold a chat conversation in which the
   agent calls tools, displays tool-call cards inline in the chat DAG,
   waits for approval on high-risk tools, and persists tool calls as
   `execution.tool_calls` rows referencing the chat message.
2. The runner consumes at least one external MCP server (configured via
   `agent.mcp_servers`) and surfaces its tools to the agent.
3. The agent can spawn N subagents in parallel via
   `agent.subagent.dispatch`, each running a scoped capability, and
   aggregate results back to the parent message.
4. The agent can execute Node/Python code in a sandbox via
   `agent.code.execute`. Output streams back as tool-call output.
5. Plan mode renders a structured plan UI before the agent executes any
   side-effectful tools; user approval is required to leave plan mode.
6. Skills load from `packages/skills` plus tenant-defined skills in
   `workflow.prompt_templates`; the agent surface lists available skills.
7. Hooks fire at `before_tool`, `after_tool`, `on_error` with stdout
   captured into ClickHouse `execution_logs`.
8. Approval flow: tools tagged `requiresApproval` pause the stream and
   render an approval card; user click resumes the stream.
9. Background tasks: `agent.task.background` dispatches a long-running
   Inngest function whose status surfaces in a workspace-scoped tasks
   panel.
10. Memory: `agent.memory.recall(query)` returns scored Neo4j matches
    and `agent.memory.write(memory)` persists a weighted memory tied to
    a graph node, per the `oxagen-feature` skill's memory contract.

### 3. Architectural Decisions

| Concern                         | Choice                                       |
|---------------------------------|----------------------------------------------|
| Tool model                      | **Unified.** Tools ARE capabilities. A capability declares `surfaces: ['agent']` (or `['api','mcp','agent']`) and the agent runtime renders any capability with `agent` in `surfaces` as a callable tool. |
| Tool transport (chat ↔ runner)  | Vercel AI SDK tool calls + Inngest events    |
| External MCP transport          | StreamableHTTP via `@modelcontextprotocol/sdk` client |
| Code sandbox                    | **Docker** (short-lived containers per invocation; pinned images; no vendor lock-in) |
| Plan storage                    | `execution.execution_steps` with step_type `plan` |
| Skill source                    | Filesystem (`packages/skills/<slug>.skill.md`) + DB (`workflow.prompt_templates`) |
| Approval UI transport           | Server-sent events on the existing chat stream |
| Tool permissions                | Per-workspace allowlist + `agent.riskLevel` gate |

#### 3.1 Unified capability/tool model

A capability declaration now carries two new optional fields:

- `surfaces: ('api' | 'mcp' | 'agent')[]` — where the capability is
  exposed. Defaults to `['api', 'mcp']`.
- `agent?: { requiresApproval?, riskLevel?, category? }` — read by the
  chat runtime when the `agent` surface is present. Ignored otherwise.

The manifest gate only requires layer files for surfaces actually
declared. A capability with `surfaces: ['agent']` skips the `api`,
`mcp`, and `e2e` layers; it still ships `schema`, `unit`, and `docs`.

This collapses the previously-separate tool registry into the contracts
array. The agent runtime filters the per-package `contracts` arrays
(`contracts.filter(c => c.metadata.surfaces.includes('agent'))`) to
materialize its tool list per turn.

#### 3.2 Docker as code sandbox

Vendor-neutral by design. The `agent.code.execute` capability spawns
a short-lived container per invocation, runs the user code inside it,
streams stdout/stderr back to the chat stream, and tears the container
down on completion or timeout.

Pinned images (declared in `packages/sandbox/images.ts`):

| Language | Image                               | Notes |
|----------|-------------------------------------|-------|
| Node 20  | `node:20-alpine`                    | npm install disabled at runtime; only stdlib + a curated bundle baked into the image |
| Python   | `python:3.12-slim`                  | numpy, pandas, requests preinstalled in the image; pip disabled at runtime |
| Shell    | `alpine:3.20`                       | busybox only |

Container flags applied to every invocation:

- `--network=none` (no outbound traffic from user code by default;
  capability gains an opt-in `network: 'allow' | 'deny'` field that
  the workspace policy may or may not permit).
- `--read-only` rootfs; `/tmp` mounted as `tmpfs` with size cap.
- `--memory=512m --memory-swap=512m` (capability override up to plan
  limit).
- `--cpus=0.5 --pids-limit=128`.
- `--user=65534:65534` (nobody:nogroup).
- `--cap-drop=ALL` plus `--security-opt=no-new-privileges`.
- Wallclock timeout enforced by the runner (default 30s, capability
  may request up to plan limit).
- Code mounted as a single `/work/main.{js,py,sh}` via temp file; no
  bind mounts from the host filesystem.

The runner maintains a small container pool per image to amortize
cold-start; cold-start budget on macOS is ~300ms, Linux ~50ms.

Limits inherited:
- Anything requiring kernel features beyond the default sandbox
  (KVM, eBPF, GPU) is out of scope for v1.
- GPU sandbox is a future epic; the driver interface accepts a
  capability hint so a GPU image can be selected later.

`packages/sandbox` exposes a `SandboxDriver` interface. The Docker
driver implements it; a future managed-provider driver (Fly Machines,
ECS, etc.) is a single-file swap.

### 4. New Capabilities

Every capability is declared in `packages/oxagen/src/contracts/`.
The `surfaces` column determines required layers; the `agent` block is
present only when `agent` is in `surfaces`.

| Capability                       | Mode  | Surfaces           | Risk |
|----------------------------------|-------|--------------------|------|
| `agent.tool.list`                | sync  | api, mcp, agent    | low  |
| `agent.subagent.dispatch`        | async | agent              | medium |
| `agent.subagent.aggregate`       | sync  | agent              | low  |
| `agent.code.execute`             | async | agent              | high |
| `agent.mcp.register`             | sync  | api, mcp           | medium |
| `agent.mcp.list`                 | sync  | api, mcp, agent    | low  |
| `agent.skill.list`               | sync  | api, mcp, agent    | low  |
| `agent.skill.load`               | sync  | agent              | low  |
| `agent.plan.create`              | sync  | agent              | low  |
| `agent.plan.approve`             | sync  | api, agent         | low  |
| `agent.task.background.start`    | async | api, mcp, agent    | medium |
| `agent.task.background.read`     | sync  | api, mcp, agent    | low  |
| `agent.task.background.cancel`   | sync  | api, mcp, agent    | medium |
| `agent.memory.recall`            | sync  | api, mcp, agent    | low  |
| `agent.memory.write`             | sync  | api, mcp, agent    | low  |
| `agent.approval.resolve`         | sync  | api, agent         | low  |

There is no separate `agent.tool.execute` — the agent invokes any
agent-surfaced capability directly via the AI SDK tool dispatch.

### 5. New Packages

#### 5.1 `packages/agent`

Runtime-side helpers. **No registry** — capabilities are the registry.

- `src/runtime/materialize-tools.ts` — turns the capability list into a
  Vercel AI SDK `tools` map for a given workspace, filtered by
  allowlist and risk policy.
- `src/dispatch/subagent.ts` — fanout via Inngest invoke.
- `src/dispatch/mcp-client.ts` — external MCP connections.
- `src/runtime/approval.ts` — pause/resume the AI SDK stream around
  approval requests.

#### 5.2 `packages/skills`

Filesystem + DB skill loader.

- `src/loader.ts` — reads `.skill.md` (same format as
  `oxagen-feature.skill`).
- `src/registry.ts` — merges filesystem skills with DB skills.
- `skills/` — built-in skills directory.

#### 5.3 `packages/sandbox`

Docker driver. Vendor-neutral; runs anywhere Docker runs.

- `src/types.ts` — `SandboxDriver` interface plus `SandboxRequest`,
  `SandboxResult`, `SandboxStreamChunk` shapes.
- `src/docker.ts` — driver implementation; uses `dockerode` to spawn,
  stream, and tear down containers per invocation.
- `src/images.ts` — pinned image registry per language.
- `src/policy.ts` — workspace-scoped policy: which languages, what
  caps, network on/off, wallclock + memory ceilings.
- `src/index.ts` — exports a `createSandbox(driver?)` factory.

### 6. Schema Additions

Postgres:

- `agent.tools` gains `requires_approval boolean`, `risk_level text`
  (`low` | `medium` | `high`), `category text`.
- `agent.tool_assignments` gains `is_enabled_in_workspace boolean`.
- New `agent.skills` table (logical skill identity) and
  `agent.skill_versions` (immutable). Same versioning pattern as
  agents/tools/playbooks.
- New `agent.background_tasks` table tracking
  `agent.task.background.*` invocations:
  - `id`, `tenant_id`, `workspace_id`, `inngest_run_id`, `status`,
    `kind`, `created_by_user_id`, `result_payload jsonb null`,
    timestamps.
- New `agent.approval_requests` table for the approval flow:
  - `id`, `execution_step_id`, `tool_call_id`, `requested_at`,
    `resolved_at`, `resolution` (`approved` | `denied` | `expired`),
    `resolved_by_user_id`.

Neo4j:

- New edge type `INVOKED` (Execution → ToolVersion).
- New edge type `LOADED_SKILL` (AgentVersion → SkillVersion).
- `AgentMemory` already has its vector index; no schema change.

ClickHouse:

- New `tool_invocations` table for high-volume tool-call telemetry
  (separate from Postgres `execution.tool_calls`, which is the durable
  record). Reasons: high write rate when the agent fans out, analytics
  queries.

### 7. Chat UI changes

`apps/app/src/components/chat/`:

- `tool-call-card.tsx` — inline tool-call render with collapsed/expanded
  states, status spinner, output preview.
- `approval-card.tsx` — approve/deny UI with risk badge, fires
  `agent.approval.resolve`.
- `plan-card.tsx` — structured plan render; approve/reject buttons.
- `subagent-fanout.tsx` — visualization of parallel subagent calls and
  their aggregated result.
- `background-task-tray.tsx` — workspace-scoped tray showing
  long-running tasks.

Streaming changes: the AI SDK stream now interleaves
`tool-call-start`, `tool-call-output`, `tool-call-end`,
`approval-required`, `plan-proposed`, `subagent-dispatched` events.
Existing message DAG storage handles all of these as additional
content blocks on the assistant message.

### 8. Tool Permissions

Per-workspace tool allowlist enforced server-side in
`agent.tool.execute`. Default-deny for tools tagged
`risk_level=high`. Defaults configurable per plan tier in
`billing.plans.features.toolPolicy`.

### 9. Observability

Every tool call produces:
- One `execution.tool_calls` row (durable).
- One ClickHouse `tool_invocations` row (analytics).
- One Neo4j `INVOKED` edge.
- For external MCP tools: an additional `external_provider`,
  `external_server_id` column on `tool_calls`.

Approval requests produce one `agent.approval_requests` row plus a
ClickHouse `events` row of `event_type=approval.requested`.

### 10. Acceptance Tests

Beyond the per-capability E2E tests:

1. A scripted Playwright scenario where the agent plans, requests
   approval, executes three subagents in parallel, runs sandboxed
   code, and writes a memory. The test asserts the resulting message
   DAG, the Postgres `execution.tool_calls` rows, and the Neo4j
   `INVOKED` edges.
2. A load test: 100 concurrent tool calls per tenant for 60s; verify
   no N+1 queries, all `tool_invocations` rows ingest into
   ClickHouse, no tenant cross-contamination.

### 11. Out of Scope

- Marketplace UI for installing third-party skills (handled by future
  plugin epic).
- Visual workflow editor for playbooks.
- Cross-tenant tool sharing.
- Multi-region runner deployment.

## Plan — `plan.md`

## Agent Runtime — Implementation Plan

Sequenced after the foundations epic ships.

### Phase 0 — ADRs

- [ ] ADR-007: Docker (vendor-neutral) as code sandbox
- [ ] ADR-008: Skills as filesystem-first with DB augmentation
- [ ] ADR-009: Unified capability/tool model via `surfaces` field
- [ ] ADR-010: Subagent fanout via Inngest invoke vs separate worker pool

### Phase 1 — Packages

- [ ] `packages/agent` — tool registry, dispatch primitives
- [ ] `packages/sandbox` — E2B wrapper
- [ ] `packages/skills` — filesystem loader + registry

### Phase 2 — Schema additions

- [ ] Postgres: extend `agent.tools`, `agent.tool_assignments`; new
      `agent.skills`, `agent.skill_versions`,
      `agent.background_tasks`, `agent.approval_requests`
- [ ] ClickHouse: `tool_invocations` table
- [ ] Neo4j: `INVOKED`, `LOADED_SKILL` edge types

### Phase 3 — Capability declarations

All 17 capabilities listed in spec §4 declared in
`packages/oxagen/src/contracts/`. Each ships every layer; manifest
gate must remain green at all times — implement one capability
top-to-bottom before starting the next.

### Phase 4 — Runtime integrations

- [ ] External MCP client (StreamableHTTP)
- [ ] E2B sandbox session manager
- [ ] Subagent dispatch via Inngest fanout
- [ ] Skills loader: filesystem + DB merge
- [ ] Hooks runtime (before_tool, after_tool, on_error)

### Phase 5 — Chat UI

- [ ] Tool-call card component
- [ ] Approval card + stream pause/resume
- [ ] Plan card + approval flow
- [ ] Subagent fanout visualization
- [ ] Background task tray

### Phase 6 — Permissions

- [ ] Per-workspace tool allowlist enforced in `agent.tool.execute`
- [ ] Plan-tier tool policy in `billing.plans.features.toolPolicy`

### Phase 7 — Acceptance tests

- [ ] Playwright scenario covering plan → approve → fanout → sandbox →
      memory write
- [ ] Load test: 100 concurrent tool calls / tenant for 60s

### Done

§2 acceptance criteria pass on a fresh clone, manifest gate green,
verification gate green.

