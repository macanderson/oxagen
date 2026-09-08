# Architecture Decision Records

Single-page rationale per architectural decision. Each ADR records
context, decision, alternatives, and consequences. New ADRs are
sequentially numbered and never edited after acceptance — supersede
with a new ADR if the call changes.

## Foundations epic

- [ADR-001](./ADR-001-drizzle-as-postgres-orm.md) — Drizzle as Postgres ORM
- [ADR-002](./ADR-002-inngest-as-job-orchestration.md) — Inngest as job orchestration
- [ADR-003](./ADR-003-neo4j-as-vector-store.md) — Neo4j as vector store
- [ADR-004](./ADR-004-env-vars-not-secret-manager.md) — Environment variables, not Google Secret Manager
- [ADR-005](./ADR-005-single-version-monorepo.md) — Single-version monorepo via Changesets
- [ADR-006](./ADR-006-better-auth-bound-to-canonical-users.md) — Better Auth bound to canonical `auth.users`

## Agent Runtime epic

- [ADR-007](./ADR-007-docker-as-code-sandbox.md) — Docker as vendor-neutral code sandbox
- [ADR-008](./ADR-008-skills-filesystem-first.md) — Skills as filesystem-first with DB augmentation
- [ADR-009](./ADR-009-unified-capability-tool-model.md) — Unified capability/tool model via `surfaces`
- [ADR-010](./ADR-010-subagent-fanout-via-inngest.md) — Subagent fanout via Inngest invoke
- [ADR-011](./ADR-011-vercel-sandbox-driver.md) — Vercel Sandbox driver for Vercel Functions

## Marketplace epic

- [ADR-012](./ADR-012-connector-dual-write-pattern.md) — Connector dual-write to Postgres + Neo4j
- [ADR-013](./ADR-013-oxagen-plugins-capability-packs.md) — Oxagen Plugins: first-party capability packs as a fourth plugin type
- [ADR-014](./ADR-014-workspace-scoped-mcp-registry-single-default.md) — Workspace-scoped MCP registries with a single-default state machine

## Developer workflow epic

- [ADR-015](./ADR-015-graph-edge-driven-git-hooks-and-biome.md) — Graph-edge-driven git hooks (Vitest import-graph) + Biome formatting

## CLI & Local Agent Runtime epic

- [ADR-016](./ADR-016-oxagen-cli-daemon-live-code-graph.md) — Oxagen CLI daemon: live code-graph memory fed by coding-agent hooks (Proposed)

## Not yet filed under an epic

The lists above stopped being extended at ADR-016 while the directory
kept growing, so an index that read as complete was missing most of it.
These are every ADR the sections above do not already link, oldest
first. Move a row into its epic when one fits.

- [ADR-017](./ADR-017-opentelemetry-distributed-tracing.md) — ADR-017 — OpenTelemetry Distributed Tracing
- [ADR-018](./ADR-018-cli-workspace-graph-bidirectional-sync.md) — CLI ↔ Workspace Graph Bidirectional Sync
- [ADR-019](./ADR-019-unified-agent-engine.md) — Unified agent engine — one brain across CLI and platform
- [ADR-020](./ADR-020-per-workspace-github-write-credentials.md) — Per-workspace GitHub write credentials
- [ADR-021](./ADR-021-inference-doctrine.md) — Inference doctrine — deterministic-first, cache-aligned, structured-tool agentic coding
- [ADR-022](./ADR-022-capability-naming-standard.md) — Capability & tool naming standard
- [ADR-023](./ADR-023-cli-fleet-session-event-log.md) — sessions as append-only event logs, views as renderers
- [ADR-024](./ADR-024-namespaced-agent-identity.md) — ADR-024 — Namespaced, immutable agent identity (`org_ns.workspace_ns.agent_slug`)
- [ADR-025](./ADR-025-verb-first-snake-naming.md) — Verb-first snake_case capability naming
- [ADR-026](./ADR-026-mobile-feature-parity.md) — ADR-026 — Mobile feature parity is law, enforced by a manifest gate
- [ADR-027](./ADR-027-multi-tenant-github-app-connect.md) — Multi-tenant GitHub App connect (identity leg + installation registry)
- [ADR-028](./ADR-028-time-travel-replay.md) — deterministic session records, bisect, resume, and failure→eval distillation
- [ADR-029](./ADR-029-mutation-verifier-gate.md) — The mutation verifier gate — every green turn must prove its tests witness the fix
- [ADR-030](./ADR-030-speculative-tool-execution.md) — Speculative tool execution — prefetch the model's next reads while it thinks
- [ADR-031](./ADR-031-platform-storage-ontology.md) — Platform Storage Ontology — a drift-aware, machine-readable self-model of the platform's storage layer
- [ADR-032](./ADR-032-unified-chat-session-state.md) — ADR-032 — Unified chat session state (chat_ux_v2)
- [ADR-033](./ADR-033-stella-engine-core.md) — Adopt the Stella Rust engine as the platform agent core
- [ADR-034](./ADR-034-customer-capability-packages.md) — Customer-built capability packages (`.cap`)
- [ADR-035](./ADR-035-consume-context-graph-protocol-directly.md) — Consume the Context Graph Protocol directly via pinned conformance fixtures
- [ADR-036](./ADR-036-adopt-cgp-typescript-sdk.md) — Adopt the official CGP TypeScript SDK as the canonical type source
- [ADR-037](./ADR-037-test-doubles-must-fail-when-their-original-moves.md) — A test double must fail when the thing it doubles moves
- [ADR-038](./ADR-038-adopt-standing-decisions-scr-corpus.md) — Adopt org standing decisions as a Steering Context Record corpus
- [ADR-039](./ADR-039-centralize-scr-enforcement-in-oxagen.md) — Centralize SCR enforcement in oxagen rather than replicating it
- [ADR-040](./ADR-040-governance-plane-refocus.md) — Refocus Oxagen as an engine-agnostic governance plane
- [ADR-041](./ADR-041-canonical-json-one-rule-not-one-implementation.md) — Canonical JSON — one rule, not one implementation
- [ADR-044](./ADR-044-memory-record-merge-is-total.md) — Every field of a memory record has a merge rule
- [ADR-045](./ADR-045-pin-cross-repo-reusable-workflows.md) — Cross-repo reusable workflows are pinned to a commit
- [ADR-046](./ADR-046-per-commit-ci-concurrency-on-main.md) — A push to main gets its own CI concurrency group
- [ADR-047](./ADR-047-no-provider-posture-matrix.md) — No provider-posture matrix; handle divergence at the gateway
- [ADR-048](./ADR-048-one-path-glob.md) — One path glob, in a package with no dependencies
- [ADR-049](./ADR-049-dod-recheck-reruns-the-old-run.md) — The DoD recheck re-runs the old run rather than reporting a new check
- [ADR-050](./ADR-050-secret-access-in-the-main-audit-log.md) — Privileged secret access is recorded in the main audit log, not only beside it
- [ADR-051](./ADR-051-context-records-enter-the-turn-as-volatile-policy.md) — A workspace's context records enter the turn as volatile policy, not as prefix
