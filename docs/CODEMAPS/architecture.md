<!-- Generated: 2026-07-06 | Files scanned: 2,799 (ts/tsx, non-test) | Token estimate: ~800 -->

# Architecture — Oxagen v2

## Project Type
**Monorepo** (pnpm workspaces + Turborepo) — 7 apps, 30 packages, `bench/web` dashboard, 2 tooling packages. See `docs/VISION.md` for product north star: the metered, governed, graph-grounded control plane ("Stripe for agents").

## System Diagram

```
                        ┌───────────────────────────────────────┐
                        │                Clients                  │
                        │  Browser │ CLI │ MCP Client │ A2A Caller │
                        └─────┬────┴──┬──┴─────┬──────┴─────┬─────┘
                              │       │         │            │
                    ┌─────────▼──┐ ┌──▼─────┐ ┌─▼─────────┐  │
                    │  apps/app  │ │apps/cli│ │ apps/mcp  │  │
                    │ Next.js 15 │ │  Ink   │ │  xmcp     │  │
                    │  (RSC+SA)  │ │  REPL  │ │ /mcp SSE  │  │
                    └─────┬──────┘ └───┬────┘ └──┬────────┘  │
                          │            │           │          │
                          └────────────┼───────────┴──────────┘
                                       │  REST + SSE + JSON-RPC (A2A)
                              ┌────────▼────────────┐
                              │      apps/api        │
                              │   Hono on Node.js    │
                              │   api.oxagen.sh       │
                              │  (238 route files,    │
                              │   /a2a JSON-RPC + SSE)│
                              └──┬────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
    ┌─────────▼──────┐  ┌────────▼──────┐  ┌───────▼────────┐
    │  PostgreSQL     │  │   Neo4j       │  │   Inngest      │
    │  (Neon/local)   │  │  Knowledge    │  │  Background    │
    │  Drizzle ORM    │  │   Graph       │  │  Jobs (49 fns) │
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
| `apps/api` | api.oxagen.sh | Hono + Node.js | REST API, webhooks, LLM proxy, A2A JSON-RPC |
| `apps/app` | app.oxagen.sh | Next.js 15 (App Router) | Web UI, Server Actions |
| `apps/mcp` | mcp.oxagen.sh/mcp | xmcp (streamable HTTP) | MCP protocol surface |
| `apps/cli` | npm: `oxagen` | Ink + Commander | Local agent REPL + fleet orchestration |
| `apps/docs` | docs.oxagen.sh | Fumadocs (Next.js) | Documentation site |
| `apps/web` | oxagen.sh | Static | Public site / investor deck (interim) |
| `apps/schemas` | schemas.oxagen.sh | Static host | Generated JSON Schemas (editor autocompletion) |
| `bench/web` | — | Next.js | `@oxagen/bench-web` eval/replay dashboard |

## Data Flow — Chat / Agent Execution

```
User → app/chat → SA: chatMessageSendRoute
     → POST /v1/:org/:ws/chat/messages
     → @oxagen/agent runtime
     → SSE stream back to client
     → Inngest: chat.persist-stream
     → Engram memory consolidation
     → Neo4j graph sync
```

## Data Flow — Background Agent / Fleet

```
CLI/MCP/A2A → agent.subagent.dispatch
            → Inngest: agent.execute-subagent
            → @oxagen/agent-engine pipeline (planner/fork/oracle/evaluate)
            → Tool calls (sandbox/browser/code)
            → agent.sync-execution-to-graph
            → Neo4j lineage (agent.trace.get / `oxagen trace`)
```

## Data Flow — A2A (Agent2Agent) Interop

```
External caller → POST /v1/:org/:ws/a2a  (JSON-RPC: message/send, tasks/get,
                                            tasks/resubscribe, tasks/cancel)
                → message.metadata.skillId selects a deployed agent slug
                  (unknown/inactive slug falls back to the generic agent)
                → apps/api/src/routes/a2a/{rpc,bridge,protocol,stream-registry}.ts
                → same execution + lineage pipeline as subagent fan-out
                → tasks/resubscribe live-attaches to the in-flight SSE stream
                  instead of polling
```

## Tenancy Model
Hierarchy: **Organization → Workspace → User**
- API keys carry `orgId + workspaceId` scope (no session needed)
- All `orgScoped` routes require `authMiddleware + orgMiddleware + workspaceMiddleware`
- `@oxagen/tenancy` enforces boundary checks

## Key Cross-Cutting Packages

| Package | Role |
|---------|------|
| `@oxagen/oxagen` | Contracts (Zod, 319 files), CapabilityContext type, capability kernel |
| `@oxagen/handlers` | Shared business logic handlers (245 files) |
| `@oxagen/database` | Drizzle schema + client (37 files, 46 migrations) |
| `@oxagen/engram` | Memory system: embed/store/retrieve/sync (63 files) |
| `@oxagen/agent` | Agent runtime, dispatch, memory adapters (111 files) |
| `@oxagen/agent-engine` | Pipeline, planner, fork, oracle, evaluator, fleet (39 files) |
| `@oxagen/iam` | AuthZ, audit, access requests |
| `@oxagen/auth` | Better Auth, session/API-key resolution |
| `@oxagen/billing` | Stripe, credits, usage metering |
| `@oxagen/inngest-functions` | All async background jobs (49 functions) |
