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
