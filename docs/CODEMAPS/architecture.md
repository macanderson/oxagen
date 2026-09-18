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
     → workspace memory (Neo4j :AgentMemory; @oxagen/engram is not on this path, see
       "Steering, gating and the gateway")
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

## Steering, gating and the gateway

Approved by the maintainer on 2026-09-18 (ADR-091 to ADR-096). This section
states the present first, in the status words the ADRs fix, and then the target
with the phase that delivers each part.

### What is true today (`main`, 2026-09-18)

- Almost nothing reaches a wrapped agent. Records, the bundle's
  `context.system` (hardcoded `null` in
  `packages/handlers/src/lib/tacho-host.ts`), bundle permissions and budget
  (always empty, `budget.mode = "observed"`) and skills (inventory only) do not
  steer any Claude Code or Codex run. Operator steer commands are the only live
  server-to-running-agent text channel for wrapped agents. Phase 0 (PR #3289,
  ADR-091) is in review and changes the first of these.
- The wrapped tier is a recorder plus a kill switch. No model proxy exists. No
  sandbox exists. The MCP gateway is real and server-enforced but registered
  only into Claude Desktop. Spend for Claude Code is self-reported; Codex and
  Stella report none.
- Memory reaches only the in-app agent (capped at 6). `packages/engram` and
  `packages/context-provider` have no production importer. The graph holds no
  steering.
- `apps/app_deprecated` is drift. It is still in the tree and holds the only
  other `resolvePrompt` wiring (its chat stream route and agent-defaults page).
  The cutover has happened (`APP_DIR` is `apps/app`), and WL-53 of the rev1
  worklist deletes the directory (`apps/app/ARCHITECTURE.md` §7.1, "one release
  after cutover"). Phase 1 must not port its wiring: the in-app agent's
  `assistant-turn.ts` moves to the one assembler and the deprecated copy goes.

### The target

```
            AUTHORING (one surface: Steering)
   records | skills | memory | ontology | policy | proposals
                       |
            one item type: SteeringItem
   id, lineage, kind, force, scope, body, token_cost,
   enforcement grant?, provenance, hash, valid_from
                       |
        +--------------+---------------+
        |                              |
  compile to TEXT                compile to GATES
  assembleSteering(run, budget)  bundle permissions + kernel rules
  ranked, budgeted, recorded     deterministic, never budgeted
        |                              |
        +-------------+----------------+
                      |
                 THE GATEWAY (tachod grows into it)
   hook adapter | local model proxy | MCP aggregator | control channel
                      |
   tiers, computed from what was actually routed:
   observe -> harness -> gateway -> contained (sandbox)
```

Steering is what the model reads: advisory, ranked, budgeted, may be dropped.
Gating is what the kernel refuses: deterministic, never budgeted, never ranked,
works when Neo4j is down. The two planes never merge (ADR-092). Storage stays
plural with one writer per fact: git for what is published, Postgres for what
must be transactional or money-grade, the graph for lineage, evidence and entity
links. Only the assembler and its index are single.

Oxagen does not own the context window; the harness does. Oxagen's injection
points are exactly five: `SessionStart` additional context (capped at 16 KiB),
`UserPromptSubmit` additional context, MCP tool results, files in the checkout
(including skills), and the model request itself once the gateway's proxy
exists (ADR-093).

### The six phases

Each phase ships alone. The names and numbers are fixed. The order of build is
Phase 0 in review, Phase 4 in build, then Phases 1, 2, 3, 5.

| Phase | What it delivers | ADR | Status |
|---|---|---|---|
| 0. Make one record steer one agent | Active `must` and `should` records compile into `context.system` in `unsignedBundle`. New governance ceremony is frozen until this lands | ADR-091 | In review, PR #3289 |
| 1. One type, one assembler | `SteeringItem`, `assembleSteering`, the source adapters, `packages/context-provider` as the home, `packages/engram` deleted or folded in, `UserPromptSubmit` calls the assembler (tight timeout, fail open), precedence fixed, the two publish paths collapse, the in-app agent uses the same assembler | ADR-092, ADR-093 | Not started |
| 2. One screen | Steering is the hub: Records, Skills, Memory, Ontology, Policy, Proposals, Preview | ADR-092 | Not started |
| 3. The graph becomes the index | `:Record` nodes with `ABOUT` edges, registry to graph, verified by hash, Postgres kept as the fallback behind the same port | ADR-093 | Not started; waits for the knowledge graph on by default |
| 4. The gateway | Loopback model proxy in `tachod`, enrollment writes the base URL, observed metering, enforced `session_limit_usd`, real `interrupt`, MCP aggregator, bundle permissions from the second compilation | ADR-094, ADR-095 | In build now |
| 5. The contained tier | `oxagen run -- <agent>` under an OS sandbox with egress limited to the gateway; the witness runner on the same launcher | ADR-096 | Not started |

### The words a surface may use

- Hook tier (`harness`): "delivered", "recorded", "client-attested",
  "fail-open". Never "enforced".
- Gateway tier: "observed" metering, "enforced" budgets on routed traffic.
- Contained tier: "enforced".
- A control claim always carries its scope: "for actions routed through Oxagen".

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
| `@oxagen/engram` | Local DuckDB memory. No app, handler or function imports it (only `@oxagen/context-provider` and `tools/scripts`). Deleted or folded into the assembler in Phase 1 (ADR-093) |
| `@oxagen/context-provider` | Context Graph Protocol provider over engram, and the tree's only token budgeter (`packWithinBudget`). No production importer today. Becomes the home of `assembleSteering` in Phase 1 (ADR-093) |
| `@oxagen/agent` | Governed in-app agent turn loop (`runGovernedTurn`), MCP tool gateway, agent registry handlers (~73 files). No sandbox, subagent dispatch, or coding pipeline — see ADR-043. |
| `@oxagen/run-ledger` | Durable run/attempt/event/seal evidence ledger (formerly `agent-runner`) |
| `@oxagen/iam` | AuthZ, audit, access requests |
| `@oxagen/auth` | Better Auth, session/API-key resolution |
| `@oxagen/billing` | Stripe, credits, usage metering |
| `@oxagen/inngest-functions` | All async background jobs (~48 functions, count drifts) |
