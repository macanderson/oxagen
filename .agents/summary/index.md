# Documentation Index

> **AI Assistants**: Start here. This file tells you which documentation file to read for any type of question about the oxagen-monorepo codebase.

## How to Use This Index

1. Read the query-to-file routing guide below to find the most relevant file
2. Load only the files needed for your current task — each file is self-contained
3. `AGENTS.md` in the repo root contains a concise navigation guide and custom instructions
4. When in doubt, start with `architecture.md` for system design and `components.md` for code location

---

## File Summaries

### `codebase_info.md`
**What**: Project identity, versions, technology stack table, full package listing with one-line purposes.  
**When to read**: Need to know what version, what runtime requirements, what packages exist, what each package does at a glance.  
**Key facts**: v0.4.0, Node 24+, TypeScript 6, pnpm 10, Turborepo. 5 apps, 22 packages, ~265k LOC.

### `architecture.md`
**What**: System architecture — the capability kernel pattern, gate injection, surface model, storage boundaries, agent runtime flow, multi-tenancy.  
**When to read**: Need to understand how the system is structured, how a request flows, how IAM/billing/entitlement gates work, how Neo4j/Postgres/ClickHouse boundaries are enforced.  
**Key diagrams**: kernel `invoke()` flowchart, single-source-of-truth pattern, data storage boundary diagram, agent runtime sequence.

### `components.md`
**What**: Every package and app explained — what files do what, which functions/classes are important.  
**When to read**: Need to find where specific logic lives, understand package responsibilities, locate a specific handler or service.  
**Key navigations**: `packages/oxagen/src/kernel.ts` (dispatch), `packages/handlers/src/register.ts` (all handlers), `apps/app/src/app/api/v1/chat/stream/route.ts` (SSE endpoint).

### `interfaces.md`
**What**: APIs, contracts, protocols. `CapabilityDeclaration`, `CapabilityContext`, gate injection types, HTTP routes, MCP tool structure, streaming chat protocol, connector interface, env vars.  
**When to read**: Need to know type signatures, how to write a new capability, how the HTTP API is structured, how MCP tools are built.

### `data_models.md`
**What**: All 16 Postgres schemas, Neo4j node/edge model, billing data model, IAM data model, plugin model, ingestion model, ClickHouse event schema.  
**When to read**: Need to understand database structure, write a query or migration, understand entity relationships, work with billing ledger or IAM tables.

### `workflows.md`
**What**: Step-by-step flow diagrams for all major processes.  
**When to read**: Need to trace a request end-to-end, understand how ingestion works, how playbooks execute, how IAM is resolved, how billing gates fire.  
**Key flows**: Chat turn, ingestion pipeline, IAM resolution, billing gate, release workflow, GDPR erasure, subagent fanout.

### `dependencies.md`
**What**: External runtime infrastructure (Postgres, Neo4j, ClickHouse, Inngest, Stripe), npm package map by domain, workspace overrides, external service auth methods.  
**When to read**: Adding a new dependency, understanding what external services the platform calls, troubleshooting a native build dependency.

### `review_notes.md`
**What**: Consistency check results, completeness gaps, recommendations.  
**When to read**: Auditing documentation quality or understanding what's not yet documented.

---

## Query Routing Guide

| Question | File to Read |
|---|---|
| "What does this repo do overall?" | `codebase_info.md`, then `architecture.md` |
| "Where is the [X] feature implemented?" | `components.md` |
| "How does IAM / permissions work?" | `architecture.md` §IAM, `data_models.md` §IAM, `workflows.md` §IAM Resolution |
| "How do I add a new capability?" | `interfaces.md` §Capability Contract Interface |
| "How does billing work?" | `data_models.md` §Billing, `workflows.md` §Billing Turn Gate, `components.md` §billing |
| "What are the Postgres schemas?" | `data_models.md` §Postgres Schemas |
| "How does Neo4j fit in?" | `architecture.md` §Data Storage Boundaries, `data_models.md` §Neo4j |
| "How does a chat message get processed?" | `workflows.md` §Chat Turn |
| "How does ingestion work?" | `workflows.md` §Ingestion Pipeline, `components.md` §packages/ingestion |
| "What external services does this use?" | `dependencies.md` §External Services |
| "How do I run/build the project?" | `codebase_info.md`, repo `README.md`, `CONTRIBUTING.md` |
| "How is RLS / multi-tenancy enforced?" | `architecture.md` §Multi-tenancy |
| "How do plugins work?" | `data_models.md` §Plugin, `components.md` §packages/plugins, `interfaces.md` §Plugin Schema |

---

## Maintenance & Regeneration

These summaries live in `.agents/summary/` and are **manually maintained** — there is no `pnpm docs:generate` script. Regenerate or refresh after major feature additions (e.g. plugins phase 2, new connectors) by re-running the documentation SOP:

- Run the `doc-updater` agent, or the `/update-docs` and `/update-codemaps` skills, to re-derive these files from source-of-truth files (schemas, routes, contracts, exports).
- Then hand-verify the drift-prone facts:
  - **Schema count** — `grep -c 'pgSchema(' packages/database/src/schema/_schemas.ts` (keep `data_models.md`, `architecture.md`, `codebase_info.md`, and this file in agreement).
  - **Surface list** — `api`/`mcp`/`agent`/`cli`/`app`, consistent across `architecture.md` and `interfaces.md`.
  - **Capability parity** — `pnpm check:manifest`.
  - **ADR links** — every file under `docs/adr/` should be reachable from `architecture.md` §Architecture Decision Records.

## Related Files in Repo Root

| File | Purpose |
|---|---|
| `AGENTS.md` | AI agent navigation guide (concise, start here) |
| `CLAUDE.md` | Engineering operating rules, test gate policy, prime directives |
| `README.md` | Project overview, setup, tech stack |
| `CONTRIBUTING.md` | Development workflow, coding standards |
| `docs/capabilities/_index.md` | All 140+ capability docs |
| `docs/adr/` | Architecture Decision Records |
| `packages/oxagen/capabilities.manifest.json` | Machine-readable capability manifest |
