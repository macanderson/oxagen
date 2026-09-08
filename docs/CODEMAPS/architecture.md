<!-- Generated: 2026-07-06, corrections applied 2026-07-10 | Files scanned: 3,092 (ts/tsx, non-test) | Token estimate: ~800 -->

# Architecture — Oxagen v2

## Project Type
**Monorepo** (pnpm workspaces + Turborepo) — 7 apps, 27 packages (down from ~36 pre-ADR-043: `agent-engine`, `agent-worker`, `sandbox`, `skills`, `agent-artifacts`, `stella-engine-client`, and the search/fetch `web` package were removed; `agent-runner` was renamed `run-ledger`), plus `tools/` (codemods, env-manager, scripts). See `docs/VISION.md` for product north star: the metered, governed, graph-grounded control plane ("Stripe for agents").

## System Diagram

```
                        ┌──────────────────────────────┐
                        │            Clients             │
                        │  Browser │ CLI │ MCP Client    │
                        └─────┬────┴──┬──┴─────┬─────────┘
                              │       │         │
                    ┌─────────▼──┐ ┌──▼─────┐ ┌─▼─────────┐
                    │  apps/app  │ │apps/cli│ │ apps/mcp  │
                    │ Next.js 16 │ │  Ink   │ │  xmcp     │
                    │  (RSC+SA)  │ │  REPL  │ │ /mcp SSE  │
                    └─────┬──────┘ └───┬────┘ └──┬────────┘
                          │            │           │
                          └────────────┼───────────┘
                                       │  REST + SSE
                              ┌────────▼────────────┐
                              │      apps/api        │
                              │   Hono on Node.js    │
                              │   api.oxagen.sh       │
                              │  (~178 route files,   │
                              │   count drifts)       │
                              └──┬────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
    ┌─────────▼──────┐  ┌────────▼──────┐  ┌───────▼────────┐
    │  PostgreSQL     │  │   Neo4j       │  │   Inngest      │
    │  (Neon/local)   │  │  Knowledge    │  │  Background    │
    │  Drizzle ORM    │  │   Graph       │  │ Jobs (~48 fns, │
    │                 │  │               │  │  count drifts) │
    └─────────┬───────┘  └───────────────┘  └────────────────┘
              │
    ┌─────────▼──────────────────────────────────────┐
    │              External Services                  │
    │  Stripe · Vercel Blob · GitHub App · AI Gateway │
    │  ClickHouse (telemetry) · DuckDB (local Engram)  │
    └─────────────────────────────────────────────────┘
```

## Service Boundaries

| Service | URL | Stack | Role |
|---------|-----|-------|------|
| `apps/api` | api.oxagen.sh | Hono + Node.js | REST API, webhooks, LLM proxy |
| `apps/app` | app.oxagen.sh | Next.js 16 (App Router) | Web UI, Server Actions |
| `apps/mcp` | mcp.oxagen.sh/mcp | xmcp (streamable HTTP) | MCP protocol surface |
| `apps/cli` | npm: `oxagen` | Ink + Commander | Local agent REPL + fleet orchestration |
| `apps/docs` | docs.oxagen.sh | Fumadocs (Next.js) | Documentation site |
| `apps/web` | oxagen.sh | Static | Public site / investor deck (interim) |
| `apps/schemas` | schemas.oxagen.sh | Static host | Generated JSON Schemas (editor autocompletion) |

## Data Flow — Chat / Agent Execution

ADR-043 (`docs/adr/ADR-043-runtime-excision.md`) deleted `@oxagen/agent-engine`
(the coding pipeline: planner/fork/oracle/evaluate), the sandbox/browser/code
tool surface, and subagent fan-out. What remains is one thin, in-process
governed turn loop over `@oxagen/agent` and `@oxagen/ai`:

```
User → apps/app chat UI → POST /api/v1/chat/stream
     (Next.js Route Handler, apps/app/src/app/api/v1/chat/stream/route.ts)
     → runGovernedTurn (@oxagen/agent) — tools materialized from capability
       contracts, invoked through kernel.invoke() (via withTenantDb — no HTTP
       hop to apps/api)
     → SSE stream consumed by use-tool-stream.ts
     → Inngest: chat.persist-stream
     → Engram memory consolidation
     → Neo4j graph sync
```

The app UI's primary chat path is this in-process Next.js Route Handler, not a
round trip through apps/api's Hono `/v1/:org/:ws/chat/messages` route — that
route remains for CLI/MCP/API-key callers (see CLAUDE.md "Main chat path").

## Agent lineage (post-ADR-043)

There is no more subagent dispatch/fan-out and no coding pipeline to trace
through planner/fork/oracle/evaluate steps. Lineage now comes from the
evidence ledger (`@oxagen/run-ledger`, formerly `agent-runner`): externally-run
agents (Stella's drain, a wrapper SDK) attest their own run/attempt/event
records, and `get_execution_trace` (file: `agent.trace.get.ts` /
`oxagen trace`) reads them back with Neo4j-synced lineage. Oxagen stamps,
grades, and rates the trace as evidence — it never re-runs it.

## A2A (Agent2Agent) Interop — removed

ADR-043 removed the A2A JSON-RPC transport entirely (2026-09-07): the
`.well-known/agent-card.json` discovery endpoint, `POST /a2a`, the
`a2a.card.get` capability, and the `agent.a2a_tasks` table are gone.
Third-party agent identity and interop are future work through the evidence-
ingress / MCP-gateway seam (ADR-040 Phase 2) — see
`docs/specs/a2a-agent-identity/spec.md`'s 2026-09-07 note.

## Tenancy Model
Hierarchy: **Organization → Workspace → User**
- API keys carry `orgId + workspaceId` scope (no session needed)
- All `orgScoped` routes require `authMiddleware + orgMiddleware + workspaceMiddleware`
- `@oxagen/tenancy` enforces boundary checks

## Key Cross-Cutting Packages

| Package | Role |
|---------|------|
| `@oxagen/oxagen` | Contracts (Zod; ~237 non-test contract files post-ADR-043, count drifts), CapabilityContext type, capability kernel |
| `@oxagen/handlers` | Shared business logic handlers (~224 non-test files, count drifts) |
| `@oxagen/database` | Drizzle schema + client (23 schema files, ~90 migrations, count drifts) |
| `@oxagen/engram` | Local DuckDB memory, context compilation, replay |
| `@oxagen/agent` | Governed in-app agent turn loop (`runGovernedTurn`), MCP tool gateway, agent registry handlers (~73 files). No sandbox, subagent dispatch, or coding pipeline — see ADR-043. |
| `@oxagen/run-ledger` | Durable run/attempt/event/seal evidence ledger (formerly `agent-runner`) |
| `@oxagen/iam` | AuthZ, audit, access requests |
| `@oxagen/auth` | Better Auth, session/API-key resolution |
| `@oxagen/billing` | Stripe, credits, usage metering |
| `@oxagen/inngest-functions` | All async background jobs (~48 functions, count drifts) |
