# Oxagen

> **Oxagen turns your business's data into a live, queryable knowledge
> graph and gives a fleet of AI agents permission to act on it —
> autonomously, auditably, and on your own infrastructure when you
> need it.**

## Vision

Oxagen turns a business's heterogeneous data — SQL stores, document
stores, event streams, webhooks, SaaS apps — into a single live
knowledge graph, then runs a swarm of role-specialized AI agents
(planners, workers, evaluators, coordinators) on top of it. The
agents don't just query the graph; they **enrich** it: they infer the
entities customers actually care about (Product Capabilities,
Champions, Recurring Risks, Failure Patterns) that no single
connector produces, and they bind them with edges back to every
piece of evidence that justified them. Workflows trigger off graph
mutations, run as multistep autonomous playbooks, and write their
own decisions back to the graph as audited nodes — so the business
compounds intelligence with every event, and every decision is
traceable to the agent, model, and source data that produced it.

### The universal ingestion pipeline

Every connector — Linear, Gmail, GitHub, Salesforce, a Postgres CDC
stream, a partner-built one in the marketplace — flows through the
same five stages:

```
SOURCE → INGEST → PREPROCESS → NODE UPSERT → INITIAL EDGES (same-source)
                                                    ↓
                                ENRICH (workers reason across sources,
                                        deduplicate, infer customer-
                                        specific entities)
                                                    ↓
                                          QUALITY GATE
                                                    ↓
                                              GRAPH
                                                    ↑
                              AGENT RUN ─── every node + edge an
                                            agent writes carries an
                                            edge back to its run
```

Connectors ship a **manifest** declaring their config schema, sync
model (`continuous`, `cursor`, `time-windowed`, `full-resync`,
`event-stream`), authentication, and the entity / edge types they
produce. The UI never special-cases a connector. Backfill UI shows
only for the sync models that support it.

### Inferred entities are first-class

A workspace declares its ontology hint in natural language: *"We're a
B2B SaaS. We care about Product Capabilities, Customers, Renewals,
and Champions."* Enrichment workers use that hint to look for the
entities the business cares about across every source. The same
workers that infer "Product Capability" in a SaaS workspace infer
"Patient Cohort" in a healthcare workspace, because the prompt steers
them. **One worker fleet, infinite verticals.**

Inferred nodes carry `confidence`, an explicit `source: 'worker:<name>'`,
and `DERIVED_FROM` edges to every piece of evidence — so any agent
(and any auditor) can answer "why does this exist?" Inferred nodes
decay when their evidence weakens or their sources go stale.

### Built for enterprise from day one

- **Per-org isolation by construction.** Postgres row-level
  security, ClickHouse predicate enforcement, per-workspace knowledge
  graphs.
- **Bring your own infrastructure.** BYO Neo4j endpoint, BYO LLM
  provider keys — your contracts, your data plane.
- **Least-privilege ACL/RBAC.** Per-capability access policies the
  customer controls; deny by default.
- **Full audit trail.** Every capability invocation, every agent
  memory change, every inferred entity, every model choice — traced
  to an org, workspace, user, run, model, and source data.
- **Memory you can govern.** Agent memories and inferred entities
  carry weights and half-life policies; you can see what was learned,
  when it decayed, and why.
- **Connector marketplace ready.** Manifest-driven so partners can
  ship connectors without forking the platform.

### The proof, in one line

An Oxagen workspace should be able to **communicate with customers,
approve refunds, prospect new accounts, and monitor and tune ad spend
autonomously** — and explain every decision afterward, all the way
back to the evidence that produced it.

### Built for enterprise from day one

- **Per-org isolation by construction.** Postgres row-level
  security, ClickHouse predicate enforcement, per-workspace knowledge
  graphs.
- **Bring your own infrastructure.** BYO Neo4j endpoint, BYO LLM
  provider keys — your contracts, your data plane.
- **Least-privilege ACL/RBAC.** Per-capability access policies the
  customer controls; deny by default.
- **Full audit trail.** Every capability invocation, every agent
  memory change, every model choice — traced to an org, workspace,
  user, model, and timestamp.
- **Memory you can govern.** Agent memories carry weights and
  half-life policies; you can see what was learned, when it decayed,
  and why.

### How it ships

Every feature is declared **once** in `packages/oxagen` and exposed
identically through the HTTP API (`apps/api`), the MCP server
(`apps/mcp`), and the interactive app (`apps/app`). Postgres, Neo4j,
and ClickHouse each hold the slice of state they're best at. Drift
between layers fails the verification gate before it can ship.

## Quick start

```bash
git clone <repo> oxagen
cd oxagen
cp .env.example .env.local      # fill in the values, all required
pnpm install
pnpm dev                        # boots docker stack + runs migrations + starts every app
```

When you are done, `pnpm kill` stops the apps and tears down the
Docker stack (`pnpm kill -- --volumes` for a full reset).

## Workspace layout

| Path                | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `apps/api`          | HTTP API + `/api/inngest` serve handler. `/v1` routes import capability declarations. |
| `apps/app`          | Interactive Next.js app. Vercel AI SDK + RSC streaming.          |
| `apps/mcp`          | MCP server exposing the same capabilities as `apps/api`.         |
| `apps/website`      | Marketing site. Static.                                          |
| `apps/cli`          | Ink-based developer CLI (`oxagen dev`).                          |
| `packages/oxagen`   | Capability contract registry — single source of truth.           |
| `packages/handlers` | Foundation capability implementations (shared by api + mcp).     |
| `packages/agent`    | Agent runtime: tool dispatch, hooks, approval, subagent fanout.  |
| `packages/inngest-functions` | Inngest function registry served by apps/api.           |
| `packages/database` | Drizzle schemas and migrations for all 13 Postgres domains.      |
| `packages/config`   | Zod-validated environment loader.                                |
| `packages/auth`     | Better Auth wiring against `auth.users`.                         |
| `packages/ai`       | Vercel AI SDK helpers, model registry.                           |
| `packages/billing`  | Stripe client and credit ledger logic.                           |
| `packages/ontology` | Neo4j schema, node + edge types, vector indexes.                 |
| `packages/telemetry`| ClickHouse client and telemetry helpers.                         |
| `tools/scripts`     | Dev orchestration (`dev`, `kill`, `db:check`, `db:reset`).       |
| `docs/`             | Specs, capability docs, ADRs.                                    |

## Verification gate

```bash
pnpm gate    # lint + typecheck + check:manifest + test + e2e
```

CI runs the same gate on every PR (see `.github/workflows/ci.yml`).

## Spec

The full foundations specification lives at
[`docs/epics/foundations/spec.md`](docs/epics/foundations/spec.md).
Per-capability docs live under [`docs/capabilities`](docs/capabilities).
