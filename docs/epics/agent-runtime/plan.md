# Agent Runtime — Implementation Plan

Sequenced after the foundations epic ships.

## Phase 0 — ADRs

- [ ] ADR-007: Docker (vendor-neutral) as code sandbox
- [ ] ADR-008: Skills as filesystem-first with DB augmentation
- [ ] ADR-009: Unified capability/tool model via `surfaces` field
- [ ] ADR-010: Subagent fanout via Inngest invoke vs separate worker pool

## Phase 1 — Packages

- [ ] `packages/agent` — tool registry, dispatch primitives
- [ ] `packages/sandbox` — E2B wrapper
- [ ] `packages/skills` — filesystem loader + registry

## Phase 2 — Schema additions

- [ ] Postgres: extend `agent.tools`, `agent.tool_assignments`; new
      `agent.skills`, `agent.skill_versions`,
      `agent.background_tasks`, `agent.approval_requests`
- [ ] ClickHouse: `tool_invocations` table
- [ ] Neo4j: `INVOKED`, `LOADED_SKILL` edge types

## Phase 3 — Capability declarations

All 17 capabilities listed in spec §4 declared in
`packages/oxagen/src/contracts/`. Each ships every layer; manifest
gate must remain green at all times — implement one capability
top-to-bottom before starting the next.

## Phase 4 — Runtime integrations

- [ ] External MCP client (StreamableHTTP)
- [ ] E2B sandbox session manager
- [ ] Subagent dispatch via Inngest fanout
- [ ] Skills loader: filesystem + DB merge
- [ ] Hooks runtime (before_tool, after_tool, on_error)

## Phase 5 — Chat UI

- [ ] Tool-call card component
- [ ] Approval card + stream pause/resume
- [ ] Plan card + approval flow
- [ ] Subagent fanout visualization
- [ ] Background task tray

## Phase 6 — Permissions

- [ ] Per-workspace tool allowlist enforced in `agent.tool.execute`
- [ ] Plan-tier tool policy in `billing.plans.features.toolPolicy`

## Phase 7 — Acceptance tests

- [ ] Playwright scenario covering plan → approve → fanout → sandbox →
      memory write
- [ ] Load test: 100 concurrent tool calls / tenant for 60s

## Done

§2 acceptance criteria pass on a fresh clone, manifest gate green,
verification gate green.
